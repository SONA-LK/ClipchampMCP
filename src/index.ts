import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, Page } from "playwright";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const CDP_PORT = 9222;

// Default Clipchamp desktop app path (from README). Detected at runtime if absent.
const DEFAULT_CLIPCHAMP_EXE =
  "C:\\Program Files\\WindowsApps\\Clipchamp.Clipchamp_4.5.10920.0_x64__yxz26nhyzhsrt\\Clipchamp\\Clipchamp.exe";

// Map MCP aspect ratio values to Clipchamp's "Size" menu labels.
const ASPECT_RATIO_LABELS: Record<string, string> = {
  "16:9": "Wide 16:9",
  "9:16": "Vertical 9:16",
  "1:1": "Square 1:1",
  "4:3": "Classic 4:3",
  "4:5": "Social 4:5",
  "21:9": "Cinema 21:9",
  "2:3": "Portrait 2:3",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function detectClipchampExe(): string {
  if (fs.existsSync(DEFAULT_CLIPCHAMP_EXE)) return DEFAULT_CLIPCHAMP_EXE;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-AppxPackage -Name '*Clipchamp*').InstallLocation"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (out) {
      const candidate = path.join(out, "Clipchamp", "Clipchamp.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return DEFAULT_CLIPCHAMP_EXE;
}

class ClipchampMCPServer {
  private server: Server;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor() {
    this.server = new Server(
      { name: "clipchamp-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "launch_clipchamp",
          description:
            "Launch the local Clipchamp desktop app with WebView2 remote debugging and connect via CDP. Must be called before any other tool.",
          inputSchema: {
            type: "object",
            properties: {
              headless: {
                type: "boolean",
                description: "Accepted for compatibility; the desktop app always runs with a visible window.",
                default: false,
              },
            },
          },
        },
        {
          name: "create_new_video",
          description:
            "Start a new video project in the Clipchamp editor and optionally set the aspect ratio.",
          inputSchema: {
            type: "object",
            properties: {
              aspectRatio: {
                type: "string",
                enum: ["16:9", "9:16", "1:1", "4:3", "4:5", "21:9", "2:3"],
                description: "Aspect ratio for the video canvas (default: 16:9).",
              },
            },
          },
        },
        {
          name: "import_media",
          description:
            "Import media files (video, audio, images) into the project and add them to the timeline in the given order.",
          inputSchema: {
            type: "object",
            properties: {
              filePaths: {
                type: "array",
                items: { type: "string" },
                description: "Absolute paths to media files to import and add to the timeline.",
              },
            },
            required: ["filePaths"],
          },
        },
        {
          name: "export_video",
          description:
            "Export the current project as an MP4 video at the requested quality. Waits for the export to finish.",
          inputSchema: {
            type: "object",
            properties: {
              quality: {
                type: "string",
                enum: ["480p", "720p", "1080p", "4k"],
                description: "Export resolution quality (default: 1080p). 4k requires premium media.",
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
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
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }
    });
  }

  // --- helpers ---

  private activePage(): Page | null {
    if (!this.browser) return null;
    const ctx = this.browser.contexts()[0];
    if (!ctx) return null;
    // Prefer the Clipchamp app page; fall back to the most recently opened page.
    const clipchampPages = ctx.pages().filter((p) => p.url().includes("app.clipchamp.com"));
    if (clipchampPages.length > 0) {
      this.page = clipchampPages[clipchampPages.length - 1];
      return this.page;
    }
    const all = ctx.pages();
    if (all.length > 0) {
      this.page = all[all.length - 1];
      return this.page;
    }
    return null;
  }

  private requirePage(): Page {
    const page = this.activePage();
    if (!page) {
      throw new Error("Clipchamp is not active. Call launch_clipchamp first.");
    }
    return page;
  }

  // --- tool implementations ---

  private async launchClipchamp(headless: boolean) {
    try {
      // If we're already connected, just return the current state.
      if (this.browser && this.activePage()) {
        const page = this.activePage()!;
        return {
          content: [
            {
              type: "text",
              text: `Already connected to Clipchamp via CDP (port ${CDP_PORT}). Current page: ${page.url()}`,
            },
          ],
        };
      }

      // Try to connect to an existing instance with CDP already open (avoids
      // killing a running, signed-in session unnecessarily).
      let browser: Browser | null = null;
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 3000 });
      } catch {
        // No existing CDP endpoint — launch a fresh instance.
      }

      if (!browser) {
        // Kill any existing instance so the new one picks up the debug port.
        try { execSync("taskkill /F /IM Clipchamp.exe", { stdio: "ignore" }); } catch {}
        await sleep(2000);

        const exe = detectClipchampExe();
        if (!fs.existsSync(exe)) {
          throw new Error(`Clipchamp executable not found at: ${exe}`);
        }

        // Launch via PowerShell so the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var
        // is honored by the Appx-hosted WebView2 process.
        const psCmd = `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${CDP_PORT}'; Start-Process -FilePath '${exe}'`;
        execSync(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, {
          stdio: "ignore",
        });

        // Wait for the CDP endpoint to come up, then connect.
        for (let i = 0; i < 40; i++) {
          try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 4000 });
            break;
          } catch {
            await sleep(2000);
          }
        }
        if (!browser) {
          throw new Error("Timed out waiting for Clipchamp WebView2 CDP endpoint.");
        }
      }
      this.browser = browser;

      // Wait for the Clipchamp page to appear.
      let page: Page | null = null;
      for (let i = 0; i < 30; i++) {
        page = this.activePage();
        if (page && page.url().includes("app.clipchamp.com")) break;
        await sleep(1500);
      }
      if (!page) {
        throw new Error("Clipchamp launched but no app page was found.");
      }
      await page.bringToFront().catch(() => {});

      // Wait for auto-login to complete: the app may briefly show /consumer/login
      // before redirecting to /home or /editor. Wait up to 60s for the redirect.
      for (let i = 0; i < 30; i++) {
        const url = page.url();
        if (!url.includes("/consumer/login")) break;
        await sleep(2000);
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(2000);

      return {
        content: [
          {
            type: "text",
            text: `Launched Clipchamp desktop app and connected via CDP (port ${CDP_PORT}). Current page: ${page.url()}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch Clipchamp: ${error.message}` }],
      };
    }
  }

  private async createNewVideo(aspectRatio: string) {
    const page = this.requirePage();
    try {
      await page.bringToFront().catch(() => {});

      // If we're on the home page, click "Create a new video". If already in the
      // editor, skip (the project already exists).
      if (page.url().includes("/consumer/home")) {
        const createBtn = page.getByRole("button", { name: /^Create a new video/ });
        await createBtn.click({ timeout: 15000 });
        // The editor may open in the same page or a new one.
        await Promise.race([
          page.waitForURL(/\/consumer\/editor\//i, { timeout: 30000 }),
          sleep(30000).then(() => { throw new Error("Timed out waiting for editor to open."); }),
        ]);
      }

      const editorPage = this.activePage();
      if (!editorPage || !editorPage.url().includes("/consumer/editor/")) {
        throw new Error(`Did not reach the editor. Current URL: ${editorPage?.url()}`);
      }
      await editorPage.waitForLoadState("networkidle").catch(() => {});
      await sleep(2500);

      // Set aspect ratio via the "Size" control in the Stage section.
      // The "Size" element can be a <p> or <button> depending on editor state,
      // so try multiple strategies. This is best-effort — the default for a new
      // project is 16:9, so if the requested ratio is 16:9 and this fails, the
      // result is still correct.
      const label = ASPECT_RATIO_LABELS[aspectRatio];
      let ratioSet = false;
      if (label && aspectRatio !== "16:9") {
        try {
          // Strategy 1: click the "Size" text within the Stage section.
          const stage = editorPage.locator('[aria-label="Stage"]');
          await stage.getByText("Size", { exact: true }).click({ timeout: 8000 });
          await sleep(1200);
          // The size options are rendered as menu items containing the label text.
          await editorPage.getByText(label, { exact: false }).first().click({ timeout: 10000 });
          await sleep(1000);
          await editorPage.keyboard.press("Escape").catch(() => {});
          ratioSet = true;
        } catch {
          // Strategy 2: click any element with "Size" text on the page.
          try {
            await editorPage.getByText("Size", { exact: true }).first().click({ timeout: 8000 });
            await sleep(1200);
            await editorPage.getByText(label, { exact: false }).first().click({ timeout: 10000 });
            await sleep(1000);
            await editorPage.keyboard.press("Escape").catch(() => {});
            ratioSet = true;
          } catch {
            // Size control not clickable in current editor state — proceed with default.
          }
        }
      } else if (aspectRatio === "16:9") {
        ratioSet = true; // 16:9 is the default
      }

      const ratioNote = ratioSet
        ? `aspect ratio ${aspectRatio} (${label || "default"})`
        : `aspect ratio ${aspectRatio} requested but could not be set (using default 16:9)`;

      return {
        content: [
          {
            type: "text",
            text: `Created a new video project with ${ratioNote}.`,
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
    const page = this.requirePage();
    if (!filePaths || filePaths.length === 0) {
      return { isError: true, content: [{ type: "text", text: "No file paths provided." }] };
    }
    // Validate paths exist.
    const missing = filePaths.filter((f) => !fs.existsSync(f));
    if (missing.length > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `Files not found: ${missing.join(", ")}` }],
      };
    }
    try {
      await page.bringToFront().catch(() => {});

      // Make sure the "My media" sidebar is active.
      await page.getByRole("button", { name: "My media" }).click({ timeout: 10000 }).catch(() => {});
      await sleep(800);

      // Open the native file picker via the "Import media" split button's primary action.
      const importBtn = page.locator("button").filter({ hasText: "Import media" }).first();
      const [filechooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 15000 }),
        importBtn.click({ timeout: 10000 }),
      ]);
      await filechooser.setFiles(filePaths);

      // Wait for the imported items to show up in the sidebar (aria-label == basename).
      const basenames = filePaths.map((f) => path.basename(f));
      for (const name of basenames) {
        await page.locator(`[aria-label="${name}"]`).waitFor({ state: "visible", timeout: 60000 });
      }
      await sleep(1500);

      // Add each imported media item to the timeline in order.
      for (const name of basenames) {
        const addBtn = page.getByRole("button", { name: `Add ${name} to timeline` });
        await addBtn.click({ timeout: 15000 });
        await sleep(1200);
      }
      await sleep(2000);

      // Read back the timeline duration.
      const timelineText = await page.locator('[aria-label="Timeline"]').textContent().catch(() => "");
      const durationMatch = timelineText?.match(/(\d+:\d+\.\d+)\/(\d+:\d+\.\d+)/);
      const duration = durationMatch ? durationMatch[2] : "unknown";

      return {
        content: [
          {
            type: "text",
            text: `Imported ${filePaths.length} file(s) and added them to the timeline. Timeline duration: ${duration}. Files: ${basenames.join(", ")}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to import media: ${error.message}` }],
      };
    }
  }

  private async exportVideo(quality: string) {
    const page = this.requirePage();
    const q = quality.toLowerCase();
    try {
      await page.bringToFront().catch(() => {});

      // Open the export dialog from the toolbar.
      await page.getByRole("button", { name: "Export" }).first().click({ timeout: 10000 });
      await sleep(2500);

      const dialog = page.locator('[role="dialog"]');
      await dialog.waitFor({ state: "visible", timeout: 15000 });

      // Select the requested quality. 480p is hidden behind "More options".
      const qualityLabel: Record<string, string> = {
        "480p": "480p",
        "720p": "720p",
        "1080p": "1080p",
        "4k": "4K",
      };
      const wanted = qualityLabel[q] || "1080p";

      if (q === "480p") {
        await dialog.getByText("More options", { exact: true }).click({ timeout: 10000 }).catch(() => {});
        await sleep(1500);
      }

      // Quality options are spans containing the label text. Click the one we want.
      const qualityOption = dialog.getByText(wanted, { exact: true }).first();
      await qualityOption.click({ timeout: 10000 }).catch(() => {});
      await sleep(1000);

      // Start the export with the dialog's "Export" action button.
      const exportAction = dialog.getByRole("button", { name: "Export" }).first();
      await exportAction.click({ timeout: 10000 });

      // Wait for export to finish. Clipchamp shows a progress UI then a
      // success/save state. Poll for up to 10 minutes.
      let status = "unknown";
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(10000);
        const bodyText = (await page.locator("body").textContent().catch(() => "")) || "";
        if (/saved|download|export complete|successfully|your video is ready|save to computer/i.test(bodyText)) {
          status = "completed";
          break;
        }
        if (/exporting|rendering|progress|preparing/i.test(bodyText)) {
          status = "in-progress";
          continue;
        }
      }
      if (status !== "completed") status = status === "in-progress" ? "still-exporting" : "unknown";

      return {
        content: [
          {
            type: "text",
            text: `Export started at ${wanted} quality. Status: ${status}. Check your Clipchamp app for the rendered video / save prompt.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to export video: ${error.message}` }],
      };
    }
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
