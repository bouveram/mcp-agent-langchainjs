import { HttpRequest, InvocationContext, HttpResponseInit, app } from '@azure/functions';
import { type AIChatCompletionRequest, type AIChatCompletionDelta } from '../models.js';
import { ChatOpenAI } from '@langchain/openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { createAgent, AIMessage, HumanMessage } from 'langchain';
import { Readable } from 'node:stream';
import { StreamEvent } from '@langchain/core/tracers/log_stream';

const agentSystemPrompt = `## Role
You an expert assistant that helps users with managing burger orders. Use the provided tools to get the information you need and perform actions on behalf of the user.
Only answer to requests that are related to burger orders and the menu. If the user asks for something else, politely inform them that you can only assist with burger orders.
Be conversational and friendly, like a real person would be, but keep your answers concise and to the point.

## Context
The restaurant is called Contoso Burgers. Contoso Burgets always provides french fries and a fountain drink with every burger order, so there's no need to add them to orders.

## Task
1. Help the user with their request, ask any clarifying questions if needed.

## Instructions
- Always use the tools provided to get the information requested or perform any actions
- If you get any errors when trying to use a tool that does not seem related to missing parameters, try again
- If you cannot get the information needed to answer the user's question or perform the specified action, inform the user that you are unable to do so. Never make up information.
- The get_burger tool can help you get informations about the burgers
- Creating or cancelling an order requires the userId, which is provided in the request context. Never ask the user for it or confirm it in your responses.
- Use GFM markdown formatting in your responses, to make your answers easy to read and visually appealing. You can use tables, headings, bullet points, bold text, italics, images, and links where appropriate.
- Only use image links from the menu data, do not make up image URLs.
- When using images in answers, use tables if you are showing multiple images in a list, to make the layout cleaner. Otherwise, try using a single image at the bottom of your answer.
`;


export async function postChats(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const azureOpenAiEndpoint = process.env.AZURE_OPENAI_API_ENDPOINT;
  const burgerMcpUrl = process.env.BURGER_MCP_URL ?? 'http://localhost:3000/mcp';

  try {
    const requestBody = (await request.json()) as AIChatCompletionRequest;
    const { messages } = requestBody;

    const userId = process.env.USER_ID ?? requestBody?.context?.userId;
    if (!userId) {
      return {
        status: 400,
        jsonBody: {
          error: 'Invalid or missing userId in the environment variables',
        },
      };
    }

    if (messages?.length === 0 || !messages.at(-1)?.content) {
      return {
        status: 400,
        jsonBody: {
          error: 'Invalid or missing messages in the request body',
        },
      };
    }

    if (!azureOpenAiEndpoint || !burgerMcpUrl) {
      const errorMessage = 'Missing required environment variables: AZURE_OPENAI_API_ENDPOINT or BURGER_MCP_URL';
      context.error(errorMessage);
      return {
        status: 500,
        jsonBody: {
          error: errorMessage,
        },
      };
    }

        const model = new ChatOpenAI({
      configuration: { baseURL: azureOpenAiEndpoint },
      modelName: process.env.AZURE_OPENAI_MODEL ?? 'gpt-5-mini',
      streaming: true,
      useResponsesApi: true,
      apiKey: getAzureOpenAiTokenProvider(),
    });

        context.log(`Connecting to Burger MCP server at ${burgerMcpUrl}`);
    const client = new MultiServerMCPClient({
      burger: {
        transport: 'http',
        url: burgerMcpUrl,
      },
    });

    const tools = await client.getTools();
    context.log(`Loaded ${tools.length} tools from Burger MCP server`);

    const agent = createAgent({
      model,
      tools,
      systemPrompt: agentSystemPrompt,
    });

        const lcMessages = messages.map((m) =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
    );

        // Start the agent and stream the response events
    const responseStream = agent.streamEvents(
      {
        messages: [
          new HumanMessage(`userId: ${userId}`),
          ...lcMessages],
      },
      { version: 'v2' },
    );

        // Convert the LangChain stream into a Readable stream of JSON chunks
    const jsonStream = Readable.from(createJsonStream(responseStream));
    console.log(`Streaming response for userId: ${userId}`);
    console.log(`Request messages: ${JSON.stringify(jsonStream)}`);

    return {
      headers: {
        // This content type is needed for streaming responses
        // from an Azure Static Web Apps linked backend API
        'Content-Type': 'text/event-stream',
        'Transfer-Encoding': 'chunked',
      },
      body: jsonStream,
    };

  } catch (_error: unknown) {
    const error = _error as Error;
    context.error(`Error when processing chat-post request: ${error.message}`);

    return {
      status: 500,
      jsonBody: {
        error: 'Internal server error while processing the request',
      },
    };
  }
}


app.setup({ enableHttpStream: true });
app.http('chats-post', {
  route: 'chats/stream',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: postChats,
});

function getAzureOpenAiTokenProvider() {
  // Automatically find and use the current user identity
  const credentials = new DefaultAzureCredential();

  // Set up token provider
  const getToken = getBearerTokenProvider(credentials, 'https://cognitiveservices.azure.com/.default');
  return async () => {
    try {
      return await getToken();
    } catch {
      // When using Ollama or an external OpenAI proxy,
      // Azure identity is not supported, so we use a dummy key instead.
      console.warn('Failed to get Azure OpenAI token, using dummy key');
      return '__dummy';
    }
  };
}

// Transform the response chunks into a JSON stream
async function* createJsonStream(chunks: AsyncIterable<StreamEvent>) {
  for await (const chunk of chunks) {
    const { data } = chunk;
    let responseChunk: AIChatCompletionDelta | undefined;

    if (chunk.event === 'on_chat_model_stream' && data.chunk.content.length > 0) {
      // LLM is streaming the final response
      responseChunk = {
        delta: {
          content: data.chunk.content[0].text ?? data.chunk.content,
          role: 'assistant',
        },
      };
    } else if (chunk.event === 'on_chat_model_start') {
      // Start of a new LLM call
      responseChunk = {
        delta: {
          context: {
            currentStep: {
              type: 'llm',
              name: chunk.name,
              input: data?.input ?? undefined,
            },
          },
        },
      };
    } else if (chunk.event === 'on_tool_start') {
      // Start of a new tool call
      responseChunk = {
        delta: {
          context: {
            currentStep: {
              type: 'tool',
              name: chunk.name,
              input: data?.input?.input ? JSON.stringify(data.input?.input) : undefined,
            },
          },
        },
      };
    }

    if (!responseChunk) {
      continue;
    }

    // Format response chunks in Newline delimited JSON
    // see https://github.com/ndjson/ndjson-spec
    yield JSON.stringify(responseChunk) + '\n';
  }
}
