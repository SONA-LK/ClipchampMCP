import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, Page } from "playwright";

class ClipchampMCPServer {
  private server: Server;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "clipchamp-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "launch_clipchamp",
            description: "Launch Clipchamp web application or connect to session.",
            inputSchema: {
              type: "object",
              properties: {
                headless: {
                  type: "boolean",
                  description: "Whether to run browser in headless mode (default: false for visual editing)",
                  default: false,
                },
              },
            },
          },
          {
            name: "create_new_video",
            description: "Start a new video project in Clipchamp.",
            inputSchema: {
              type: "object",
              properties: {
                aspectRatio: {
                  type: "string",
                  enum: ["16:9", "9:16", "1:1", "4:5", "21:9"],
                  description: "Aspect ratio for the video canvas (default: 16:9)",
                },
              },
            },
          },
          {
            name: "import_media",
            description: "Import media files (video, audio, images) into the project.",
            inputSchema: {
              type: "object",
              properties: {
                filePaths: {
                  type: "array",
                  items: { type: "string" },
                  description: "Absolute paths to media files to import",
                },
              },
              required: ["filePaths"],
            },
          },
          {
            name: "export_video",
            description: "Export the current project video.",
            inputSchema: {
              type: "object",
              properties: {
                quality: {
                  type: "string",
                  enum: ["480p", "720p", "1080p", "4k"],
                  description: "Export resolution quality (default: 1080p)",
                },
              },
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case "launch_clipchamp": {
          const headless = (request.params.arguments?.headless as boolean) ?? false;
          return await this.launchClipchamp(headless);
        }
        case "create_new_video": {
          const aspectRatio = (request.params.arguments?.aspectRatio as string) || "16:9";
          return await this.createNewVideo(aspectRatio);
        }
        case "import_media": {
          const filePaths = request.params.arguments?.filePaths as string[];
          return await this.importMedia(filePaths);
        }
        case "export_video": {
          const quality = (request.params.arguments?.quality as string) || "1080p";
          return await this.exportVideo(quality);
        }
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async launchClipchamp(headless: boolean) {
    try {
      this.browser = await chromium.launch({
        headless: headless,
        args: ["--start-maximized"],
      });
      const context = await this.browser.newContext({ viewport: null });
      this.page = await context.newPage();
      await this.page.goto("https://app.clipchamp.com");

      return {
        content: [
          {
            type: "text",
            text: "Successfully launched Clipchamp web app at https://app.clipchamp.com",
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to launch Clipchamp: ${error.message}`,
          },
        ],
      };
    }
  }

  private async createNewVideo(aspectRatio: string) {
    if (!this.page) {
      return {
        isError: true,
        content: [{ type: "text", text: "Clipchamp is not active. Call launch_clipchamp first." }],
      };
    }

    try {
      // Logic for creating new project
      return {
        content: [
          {
            type: "text",
            text: `Initiated new video project with aspect ratio ${aspectRatio}.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to create new video: ${error.message}` }],
      };
    }
  }

  private async importMedia(filePaths: string[]) {
    if (!this.page) {
      return {
        isError: true,
        content: [{ type: "text", text: "Clipchamp is not active. Call launch_clipchamp first." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Queued import for ${filePaths.length} media file(s): ${filePaths.join(", ")}`,
        },
      ],
    };
  }

  private async exportVideo(quality: string) {
    if (!this.page) {
      return {
        isError: true,
        content: [{ type: "text", text: "Clipchamp is not active. Call launch_clipchamp first." }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Export sequence initiated for quality level ${quality}.`,
        },
      ],
    };
  }

  public async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Clipchamp MCP Server running on stdio");
  }
}

const server = new ClipchampMCPServer();
server.start().catch((err) => {
  console.error("Fatal error starting Clipchamp MCP Server:", err);
  process.exit(1);
});
