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

// Valid filter names in Clipchamp (from UI exploration).
const VALID_FILTERS = [
  "None", "Retro", "Orange and teal", "Bold and blue", "Golden hour",
  "Vibrant vlogger", "Purple undertone", "Winter sunset", "35mm", "Contrast",
  "Fall", "Winter", "Old Western", "Warm coastline", "Cool coastline",
  "Warm countryside", "Cool countryside", "Golden", "Dreamscape", "Sunrise",
  "Warm tone film", "Cool tone", "Pastel dreams", "Increased", "Scenery",
  "Portrait", "Indoors", "Outdoors", "Muted", "Black & white 1",
  "Black & white 2", "Soft B&W", "Muted B&W", "Gloomy", "Deep fried",
  "Euphoric", "Yellow and orange duotone", "Pink and purple duotone",
  "Blue and pink duotone", "Green and blue duotone", "White overlay",
  "Black overlay", "Yellow overlay", "Orange overlay", "Red overlay",
  "Pink overlay", "Purple overlay", "Blue overlay", "Turquoise overlay",
  "Green overlay",
];

// Valid effect names in Clipchamp (from UI exploration).
const VALID_EFFECTS = [
  "None", "Flash", "Pulse", "Spin", "VHS", "Rotate", "Vaporwave",
  "Chromatic aberration", "Crash zoom", "Slow zoom", "Slow zoom random",
  "Green screen", "Background removal", "Black/white removal", "Blur",
  "Blur fill", "Filmic", "Glitch", "Disco", "Color shift", "Glass",
  "Comic", "Retro graphics", "Vertical", "Radial", "Smoke",
  "Kaleidoscope", "Glow", "Diffusion",
];

// Valid transition names in Clipchamp (from UI exploration).
const VALID_TRANSITIONS = [
  "Cross fade", "Cross blur", "Burn", "Fade through black", "Fade through white",
  "Horizontal banding", "Tiles", "Hard wipe down", "Hard wipe up",
  "Hard wipe left", "Hard wipe right", "Soft wipe down", "Soft wipe up",
  "Soft wipe left", "Soft wipe right", "Diagonal soft wipe", "Blinds",
  "Barn doors - vertical", "Barn doors - horizontal", "Circular wipe",
  "Close", "Diamond - horizontal", "Diamond - vertical", "Thirds",
  "Bloom", "Collage", "Spin", "Zoom in", "Zoom out",
  "Push down", "Push up", "Push left", "Push right",
];

// Valid text style names in Clipchamp (from UI exploration).
const VALID_TEXT_STYLES = [
  "Text", "Creator", "Text box", "Pride", "Button", "Bubble", "Retro",
  "Typewriter", "Circular", "Groovy", "Fireworks", "Smoke", "Fade",
  "Clean", "Tidal", "Glitch", "Double lines", "Push through",
  "Large heading", "Outline shadow", "Quick peek", "Stencil", "Glow",
  "Statement", "Mirror", "Bouncing", "Gliding", "Funky", "Modern",
  "Fade in and zoom", "Subtitle", "Karaoke", "Multiline", "Plunging",
];

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
        {
          name: "select_timeline_item",
          description:
            "Select a timeline item by its 0-based index so that property-panel operations (filter, effect, color adjust, fade) apply to it. Use 'all' to apply to every clip sequentially.",
          inputSchema: {
            type: "object",
            properties: {
              index: {
                oneOf: [
                  { type: "integer", minimum: 0, description: "0-based index of the timeline clip to select." },
                  { type: "string", enum: ["all"], description: "Select 'all' to iterate over every clip." },
                ],
                description: "Clip index (0-based) or 'all'.",
              },
            },
            required: ["index"],
          },
        },
        {
          name: "apply_filter",
          description:
            "Apply a color filter to the selected timeline item (or all items). Call select_timeline_item first, or pass applyToAll=true.",
          inputSchema: {
            type: "object",
            properties: {
              filter: {
                type: "string",
                enum: VALID_FILTERS,
                description: "Filter name (e.g. Golden hour, Retro, Orange and teal, Black & white 1).",
              },
              applyToAll: {
                type: "boolean",
                description: "If true, apply the filter to every clip on the timeline sequentially.",
                default: false,
              },
            },
            required: ["filter"],
          },
        },
        {
          name: "apply_effect",
          description:
            "Apply a visual effect to the selected timeline item (or all items). Call select_timeline_item first, or pass applyToAll=true.",
          inputSchema: {
            type: "object",
            properties: {
              effect: {
                type: "string",
                enum: VALID_EFFECTS,
                description: "Effect name (e.g. Slow zoom, Filmic, Glitch, VHS, Blur, Glow).",
              },
              applyToAll: {
                type: "boolean",
                description: "If true, apply the effect to every clip on the timeline sequentially.",
                default: false,
              },
            },
            required: ["effect"],
          },
        },
        {
          name: "adjust_colors",
          description:
            "Adjust color properties (exposure, contrast, saturation, temperature, transparency) for the selected timeline item (or all items). Values are sliders typically in range -100 to 100 (0 = default).",
          inputSchema: {
            type: "object",
            properties: {
              exposure: { type: "number", description: "Exposure adjustment (-100 to 100, 0 = default)." },
              contrast: { type: "number", description: "Contrast adjustment (-100 to 100, 0 = default)." },
              saturation: { type: "number", description: "Saturation adjustment (-100 to 100, 0 = default)." },
              temperature: { type: "number", description: "Temperature adjustment (-100 to 100, 0 = default)." },
              transparency: { type: "number", description: "Transparency/opacity (0-100, 100 = fully opaque)." },
              applyToAll: { type: "boolean", description: "If true, apply to every clip.", default: false },
            },
          },
        },
        {
          name: "set_fade",
          description:
            "Set fade in and/or fade out duration (in seconds) for the selected timeline item (or all items).",
          inputSchema: {
            type: "object",
            properties: {
              fadeIn: { type: "number", description: "Fade in duration in seconds (e.g. 1.0)." },
              fadeOut: { type: "number", description: "Fade out duration in seconds (e.g. 1.5)." },
              applyToAll: { type: "boolean", description: "If true, apply to every clip.", default: false },
            },
          },
        },
        {
          name: "add_transition",
          description:
            "Add a transition between two adjacent clips on the timeline. The transition is applied at the boundary between clip index and clip index+1.",
          inputSchema: {
            type: "object",
            properties: {
              transition: {
                type: "string",
                enum: VALID_TRANSITIONS,
                description: "Transition name (e.g. Cross fade, Burn, Zoom in, Spin, Push left).",
              },
              betweenClip: {
                type: "integer",
                minimum: 0,
                description: "0-based index of the first clip. Transition is applied between this clip and the next.",
              },
            },
            required: ["transition", "betweenClip"],
          },
        },
        {
          name: "add_text",
          description:
            "Add a text overlay/title to the timeline. The text style determines the visual appearance and animation.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "The text content to display." },
              style: {
                type: "string",
                enum: VALID_TEXT_STYLES,
                description: "Text style name (e.g. Text, Title, Subtitle, Typewriter, Glitch). Default: Text.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "set_duration",
          description:
            "Set the duration (in seconds) of the selected timeline item. Works on images and text clips.",
          inputSchema: {
            type: "object",
            properties: {
              seconds: { type: "number", description: "Duration in seconds." },
              clipIndex: {
                type: "integer",
                minimum: 0,
                description: "0-based index of the clip to adjust. If omitted, uses the currently selected clip.",
              },
            },
            required: ["seconds"],
          },
        },
        {
          name: "list_options",
          description:
            "List all available filters, effects, transitions, and text styles in Clipchamp. Useful for discovering what creative options are available.",
          inputSchema: { type: "object", properties: {} },
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
          case "select_timeline_item": {
            const index = request.params.arguments?.index as any;
            return await this.selectTimelineItem(index);
          }
          case "apply_filter": {
            const filter = request.params.arguments?.filter as string;
            const applyToAll = (request.params.arguments?.applyToAll as boolean) ?? false;
            return await this.applyFilter(filter, applyToAll);
          }
          case "apply_effect": {
            const effect = request.params.arguments?.effect as string;
            const applyToAll = (request.params.arguments?.applyToAll as boolean) ?? false;
            return await this.applyEffect(effect, applyToAll);
          }
          case "adjust_colors": {
            const args = request.params.arguments || {};
            return await this.adjustColors(args as any);
          }
          case "set_fade": {
            const args = request.params.arguments || {};
            return await this.setFade(args as any);
          }
          case "add_transition": {
            const transition = request.params.arguments?.transition as string;
            const betweenClip = request.params.arguments?.betweenClip as number;
            return await this.addTransition(transition, betweenClip);
          }
          case "add_text": {
            const text = request.params.arguments?.text as string;
            const style = (request.params.arguments?.style as string) || "Text";
            return await this.addText(text, style);
          }
          case "set_duration": {
            const seconds = request.params.arguments?.seconds as number;
            const clipIndex = request.params.arguments?.clipIndex as number | undefined;
            return await this.setDuration(seconds, clipIndex);
          }
          case "list_options": {
            return await this.listOptions();
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

  private async requirePage(): Promise<Page> {
    let page = this.activePage();
    if (!page) {
      throw new Error("Clipchamp is not active. Call launch_clipchamp first.");
    }
    // If we're on the login page, wait for auto-login to complete
    if (page.url().includes("/consumer/login")) {
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        page = this.activePage();
        if (page && !page.url().includes("/consumer/login")) break;
      }
    }
    return page!;
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
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});

      // Always go to the home page first to create a fresh project.
      // Even if we're already in the editor, the current project might be in
      // an export state or have a stale sidebar.
      // First, wait for auto-login if we're on the login page.
      if (page.url().includes("/consumer/login")) {
        for (let i = 0; i < 30; i++) {
          await sleep(2000);
          const p = this.activePage();
          if (p && !p.url().includes("/consumer/login")) break;
        }
      }

      if (!page.url().includes("/consumer/home")) {
        // Click the "Clipchamp home" button to go back to home
        const homePos = await page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Clipchamp home"]');
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (homePos) {
          await page.mouse.click(homePos.x, homePos.y);
        }
        // Wait for home page
        for (let i = 0; i < 15; i++) {
          await sleep(2000);
          const p = this.activePage();
          if (p && p.url().includes("/consumer/home")) break;
        }
        await sleep(2000);
      }

      // Now we should be on the home page — click "Create a new video"
      const freshPage = this.activePage();
      if (!freshPage) throw new Error("No active page found.");
      await freshPage.waitForLoadState("networkidle").catch(() => {});
      await sleep(2000);

      const createBtnPos = await freshPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"));
        for (const b of btns) {
          const text = b.textContent || "";
          if (text.includes("Create a new video")) {
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      });

      if (createBtnPos) {
        await freshPage.mouse.click(createBtnPos.x, createBtnPos.y);
      } else {
        await freshPage.getByRole("button", { name: /^Create a new video/ }).click({ timeout: 15000 });
      }

      // Wait for the editor to open
      let editorFound = false;
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const p = this.activePage();
        if (p && p.url().includes("/consumer/editor/")) {
          editorFound = true;
          break;
        }
      }
      if (!editorFound) {
        throw new Error("Timed out waiting for editor to open after clicking 'Create a new video'.");
      }

      const editorPage = this.activePage();
      if (!editorPage || !editorPage.url().includes("/consumer/editor/")) {
        throw new Error(`Did not reach the editor. Current URL: ${editorPage?.url()}`);
      }
      await editorPage.waitForLoadState("networkidle").catch(() => {});
      await sleep(2500);

      // Wait for the sidebar navigation to be ready (indicates the editor is fully loaded)
      for (let i = 0; i < 20; i++) {
        const navReady = await editorPage.evaluate(() => {
          const nav = document.querySelector('[aria-label="Sidebar navigation"]');
          return nav && nav.querySelectorAll("button").length >= 5;
        }).catch(() => false);
        if (navReady) break;
        await sleep(2000);
      }

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
    const page = await this.requirePage();
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
      // First wait for the sidebar navigation to be ready.
      let navReady = false;
      for (let i = 0; i < 15; i++) {
        navReady = await page.evaluate(() => {
          const nav = document.querySelector('[aria-label="Sidebar navigation"]');
          return !!(nav && nav.querySelectorAll("button").length >= 5);
        }).catch(() => false);
        if (navReady) break;
        await sleep(2000);
      }
      console.error(`[importMedia] sidebar nav ready: ${navReady}, page URL: ${page.url()}`);

      // Click the "My media" sidebar nav button using Playwright's locator
      // (locator.click triggers React handlers, mouse.click does not).
      // The sidebar might already be open from a previous session, so we
      // click twice: first to close (if open), then to open fresh.
      const myMediaBtn = page.getByRole("button", { name: "My media" });
      await myMediaBtn.click({ timeout: 10000 }).catch(() => {});
      await sleep(1000);
      // Check if the Import media button is visible now
      let sidebarOpen = await page.locator("button").filter({ hasText: "Import media" }).first().isVisible({ timeout: 3000 }).catch(() => false);
      if (!sidebarOpen) {
        // Click again to toggle
        await myMediaBtn.click({ timeout: 10000 }).catch(() => {});
        await sleep(2000);
        sidebarOpen = await page.locator("button").filter({ hasText: "Import media" }).first().isVisible({ timeout: 3000 }).catch(() => false);
      }
      if (!sidebarOpen) {
        // Try clicking another tab first, then back to My media
        await page.getByRole("button", { name: "Text" }).click({ timeout: 10000 }).catch(() => {});
        await sleep(1500);
        await myMediaBtn.click({ timeout: 10000 }).catch(() => {});
        await sleep(3000);
      }

      // Open the native file picker via the "Import media" button.
      // We need to use Playwright's locator click (not mouse.click) to trigger
      // the filechooser event in WebView2. Try multiple locator strategies.
      let importBtn = page.locator("button").filter({ hasText: "Import media" }).first();
      let importVisible = await importBtn.isVisible({ timeout: 5000 }).catch(() => false);

      if (!importVisible) {
        // Try by text content
        importBtn = page.getByText("Import media", { exact: true }).first();
        importVisible = await importBtn.isVisible({ timeout: 5000 }).catch(() => false);
      }

      if (!importVisible) {
        // Try by evaluating and clicking via Playwright's locator on the found element
        // Use the nth button that contains "Import media" text
        const btnCount = await page.locator("button").count().catch(() => 0);
        for (let i = 0; i < btnCount; i++) {
          const text = await page.locator("button").nth(i).textContent().catch(() => "");
          if (text && text.includes("Import media") && text.length < 30) {
            importBtn = page.locator("button").nth(i);
            importVisible = true;
            break;
          }
        }
      }

      if (!importVisible) {
        throw new Error("Could not find the 'Import media' button. Make sure the My media sidebar is open.");
      }

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
    const page = await this.requirePage();
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

  // --- timeline selection helper ---

  private async selectClipByIndex(page: Page, index: number): Promise<void> {
    // Click on the timeline area to focus it.
    const timeline = page.locator('[aria-label="Timeline"]');
    await timeline.click({ position: { x: 50, y: 40 } }).catch(() => {});
    await sleep(500);

    // Find the innermost clip element at the given index.
    const box = await page.evaluate((targetIdx) => {
      const tl = document.querySelector('[aria-label="Timeline"]');
      if (!tl) return null;
      const allEls = tl.querySelectorAll("*");
      const candidates: { idx: number; x: number; y: number; w: number; h: number; area: number }[] = [];
      let clipIdx = -1;
      for (const el of allEls) {
        const text = el.textContent || "";
        if (text.includes("On track 1") && text.includes("Start time at") && text.includes("Duration is")) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > 0 && rect.height > 10 && rect.height < 200) {
            const lastCandidate = candidates[candidates.length - 1];
            if (!lastCandidate || Math.abs(rect.x - lastCandidate.x) > 20) {
              clipIdx++;
            }
            candidates.push({ idx: clipIdx, x: rect.x, y: rect.y, w: rect.width, h: rect.height, area });
          }
        }
      }
      const targetClips = candidates.filter((c) => c.idx === targetIdx);
      if (targetClips.length === 0) return null;
      targetClips.sort((a, b) => a.area - b.area);
      const best = targetClips[0];
      return { x: best.x + best.w / 2, y: best.y + best.h / 2 };
    }, index);

    if (!box) {
      throw new Error(`Could not find timeline clip at index ${index}.`);
    }

    // Use CDP-compatible mouse click at the clip's center
    await page.mouse.click(box.x, box.y);
    await sleep(3000);

    // Verify the property panel appeared
    const panelVisible = await page.evaluate(() => {
      const nav = document.querySelector('[aria-label="Property panel navigation"]');
      if (!nav) return false;
      return nav.querySelectorAll("[aria-label]").length > 0;
    });

    if (!panelVisible) {
      // Retry with a double-click
      await page.mouse.click(box.x, box.y, { clickCount: 2 });
      await sleep(3000);
    }

    // Final check — log to stderr for debugging
    const finalCheck = await page.evaluate(() => {
      const nav = document.querySelector('[aria-label="Property panel navigation"]');
      return nav ? Array.from(nav.querySelectorAll("[aria-label]")).map((e: any) => e.getAttribute("aria-label")) : [];
    });
    if (finalCheck.length === 0) {
      console.error(`[selectClipByIndex] WARNING: Property panel not visible after selecting clip ${index}`);
    }
  }

  // Click a sidebar navigation button by its aria-label (e.g. "Transitions", "Text", "My media").
  // Uses mouse.click for a real click event — evaluate .click() doesn't trigger React handlers.
  private async clickSidebarNav(page: Page, ariaLabel: string): Promise<void> {
    const pos = await page.evaluate((label) => {
      const nav = document.querySelector('[aria-label="Sidebar navigation"]');
      if (!nav) return null;
      for (const b of nav.querySelectorAll("button")) {
        if (b.getAttribute("aria-label") === label || b.textContent?.includes(label)) {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, ariaLabel);
    if (pos) {
      await page.mouse.click(pos.x, pos.y);
    }
  }

  private async getTimelineClipCount(page: Page): Promise<number> {
    return await page.evaluate(() => {
      const tl = document.querySelector('[aria-label="Timeline"]');
      if (!tl) return 0;
      // Count unique "Start time at X.00 seconds" occurrences in the timeline text.
      // Each clip has a unique start time, so this is a reliable count.
      const text = tl.textContent || "";
      const matches = text.match(/Start time at [\d.]+ seconds/g);
      if (matches) {
        // Deduplicate by the actual start time value
        const unique = new Set(matches);
        return unique.size;
      }
      return 0;
    });
  }

  // --- property panel helper ---

  private async openPropertyTab(page: Page, tabName: string): Promise<void> {
    // First verify the property panel navigation is visible
    const nav = page.locator('[aria-label="Property panel navigation"]');
    const navVisible = await nav.isVisible({ timeout: 5000 }).catch(() => false);
    if (!navVisible) {
      // No property panel — try selecting clip 0 as a fallback
      await this.selectClipByIndex(page, 0).catch(() => {});
      await sleep(2000);
    }

    // If the target tab is already active, click a different tab first to
    // force the panel to refresh its content for the newly selected clip.
    const activeTab = await page.evaluate(() => {
      const nav = document.querySelector('[aria-label="Property panel navigation"]');
      if (!nav) return null;
      // The active tab has a specific class or aria-selected
      const tabs = nav.querySelectorAll("[aria-label]");
      for (const t of tabs) {
        if (t.classList.contains("active") || t.getAttribute("aria-selected") === "true") {
          return t.getAttribute("aria-label");
        }
      }
      // Fallback: check which tab content is currently shown
      const panel = document.querySelector('[aria-label="Property panel"]');
      if (panel) {
        const text = panel.textContent || "";
        if (text.includes("Fade in") && text.includes("Fade out")) return "Fade";
        if (text.includes("Search filters")) return "Filters";
        if (text.includes("Search effects")) return "Effects";
        if (text.includes("Exposure")) return "Adjust colors";
      }
      return null;
    }).catch(() => null);

    if (activeTab === tabName) {
      // Tab is already active — click another tab then back to force refresh
      const otherTab = activeTab === "Fade" ? "Filters" : "Fade";
      const otherEl = nav.locator(`[aria-label="${otherTab}"]`);
      await otherEl.click({ timeout: 8000 }).catch(() => {});
      await sleep(1500);
    }

    // Click the target tab
    const tab = nav.locator(`[aria-label="${tabName}"]`);
    await tab.click({ timeout: 10000 });
    await sleep(2500);
  }

  // --- new tool implementations ---

  private async selectTimelineItem(index: number | string) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});

      if (index === "all") {
        const count = await this.getTimelineClipCount(page);
        return {
          content: [
            {
              type: "text",
              text: `Found ${count} clip(s) on the timeline. Use applyToAll=true on filter/effect/adjust tools to process all clips.`,
            },
          ],
        };
      }

      const idx = typeof index === "number" ? index : parseInt(index, 10);
      await this.selectClipByIndex(page, idx);
      return {
        content: [
          { type: "text", text: `Selected timeline clip at index ${idx}.` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to select clip: ${error.message}` }] };
    }
  }

  private async applyFilter(filter: string, applyToAll: boolean) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});
      const count = applyToAll ? await this.getTimelineClipCount(page) : 1;
      console.error(`[applyFilter] count=${count}, filter="${filter}", applyToAll=${applyToAll}`);
      const results: string[] = [];

      for (let i = 0; i < count; i++) {
        console.error(`[applyFilter] selecting clip ${applyToAll ? i : 0}...`);
        await this.selectClipByIndex(page, applyToAll ? i : 0);
        console.error(`[applyFilter] opening Filters tab...`);
        await this.openPropertyTab(page, "Filters");
        console.error(`[applyFilter] looking for filter "${filter}"...`);
        const panel = page.locator('[aria-label="Property panel"]');
        const filterGroup = panel.locator('[aria-label="Filters"]');
        const filterEl = filterGroup.getByText(filter, { exact: true }).first();
        const found = await filterEl.isVisible({ timeout: 5000 }).catch(() => false);
        console.error(`[applyFilter] filter visible in group: ${found}`);
        if (found) {
          await filterEl.click({ timeout: 10000 });
        } else {
          console.error(`[applyFilter] trying panel-wide search...`);
          await panel.getByText(filter, { exact: true }).first().click({ timeout: 10000 });
        }
        await sleep(1500);
        results.push(`clip ${i}: ${filter}`);
        console.error(`[applyFilter] clip ${i} done.`);
      }
      return {
        content: [
          { type: "text", text: `Applied filter "${filter}" to ${count} clip(s). ${results.join("; ")}` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to apply filter: ${error.message}` }] };
    }
  }

  private async applyEffect(effect: string, applyToAll: boolean) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});
      const count = applyToAll ? await this.getTimelineClipCount(page) : 1;
      const results: string[] = [];

      for (let i = 0; i < count; i++) {
        await this.selectClipByIndex(page, applyToAll ? i : 0);
        await this.openPropertyTab(page, "Effects");
        const panel = page.locator('[aria-label="Property panel"]');
        const effectGroup = panel.locator('[aria-label="Effects"]');
        const effectEl = effectGroup.getByText(effect, { exact: true }).first();
        const found = await effectEl.isVisible({ timeout: 5000 }).catch(() => false);
        if (found) {
          await effectEl.click({ timeout: 10000 });
        } else {
          await panel.getByText(effect, { exact: true }).first().click({ timeout: 10000 });
        }
        await sleep(1500);
        results.push(`clip ${i}: ${effect}`);
      }
      return {
        content: [
          { type: "text", text: `Applied effect "${effect}" to ${count} clip(s). ${results.join("; ")}` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to apply effect: ${error.message}` }] };
    }
  }

  private async adjustColors(args: {
    exposure?: number; contrast?: number; saturation?: number;
    temperature?: number; transparency?: number; applyToAll?: boolean;
  }) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});
      const count = args.applyToAll ? await this.getTimelineClipCount(page) : 1;
      const adjustments: string[] = [];

      // The Adjust colors tab has 5 range inputs in order:
      // [0] Exposure, [1] Contrast, [2] Saturation, [3] Temperature, [4] Transparency
      // Range is -1 to 1 for the first 4, 0 to 1 for Transparency.
      // The user provides values in -100 to 100, so we scale to -1 to 1 (or 0 to 1).
      const sliderOrder: { key: string; label: string }[] = [
        { key: "exposure", label: "Exposure" },
        { key: "contrast", label: "Contrast" },
        { key: "saturation", label: "Saturation" },
        { key: "temperature", label: "Temperature" },
        { key: "transparency", label: "Transparency" },
      ];

      for (let i = 0; i < count; i++) {
        await this.selectClipByIndex(page, args.applyToAll ? i : 0);
        await this.openPropertyTab(page, "Adjust colors");
        await sleep(1000);

        // Get all range inputs in the property panel
        const inputCount = await page.evaluate(() => {
          const panel = document.querySelector('[aria-label="Property panel"]');
          if (!panel) return 0;
          return panel.querySelectorAll('input[type="range"]').length;
        });

        if (inputCount < 5) {
          console.error(`[adjustColors] Expected 5 range inputs, found ${inputCount}`);
          continue;
        }

        for (let s = 0; s < sliderOrder.length; s++) {
          const { key, label } = sliderOrder[s];
          const value = (args as any)[key];
          if (value === undefined || value === null) continue;

          // Scale from -100..100 to -1..1 (or 0..1 for Transparency)
          const scaled = key === "transparency"
            ? Math.max(0, Math.min(1, value / 100))
            : Math.max(-1, Math.min(1, value / 100));

          // Set the value using evaluate (direct DOM manipulation + React event dispatch)
          const set = await page.evaluate(({ idx, val }) => {
            const panel = document.querySelector('[aria-label="Property panel"]');
            if (!panel) return false;
            const inputs = panel.querySelectorAll('input[type="range"]');
            if (idx >= inputs.length) return false;
            const input = inputs[idx] as HTMLInputElement;
            // Use native input setter to trigger React's onChange
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, "value"
            )?.set;
            nativeInputValueSetter?.call(input, String(val));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }, { idx: s, val: scaled });

          if (set) adjustments.push(`clip ${i} ${label}=${value}`);
          await sleep(300);
        }
      }
      return {
        content: [
          { type: "text", text: `Color adjustments applied: ${adjustments.join("; ") || "none specified"}` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to adjust colors: ${error.message}` }] };
    }
  }

  private async setFade(args: { fadeIn?: number; fadeOut?: number; applyToAll?: boolean }) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});
      const count = args.applyToAll ? await this.getTimelineClipCount(page) : 1;
      const results: string[] = [];

      for (let i = 0; i < count; i++) {
        await this.selectClipByIndex(page, args.applyToAll ? i : 0);
        await this.openPropertyTab(page, "Fade");

        const panel = page.locator('[aria-label="Property panel"]');

        if (args.fadeIn !== undefined) {
          const fadeInInput = panel.locator('input[aria-label="Fade in, in seconds"]');
          await fadeInInput.fill(String(args.fadeIn), { timeout: 10000 });
          await page.keyboard.press("Tab");
          await sleep(500);
          results.push(`clip ${i} fadeIn=${args.fadeIn}s`);
        }
        if (args.fadeOut !== undefined) {
          const fadeOutInput = panel.locator('input[aria-label="Fade out, in seconds"]');
          await fadeOutInput.fill(String(args.fadeOut), { timeout: 10000 });
          await page.keyboard.press("Tab");
          await sleep(500);
          results.push(`clip ${i} fadeOut=${args.fadeOut}s`);
        }
      }
      return {
        content: [
          { type: "text", text: `Fade settings applied: ${results.join("; ") || "none specified"}` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to set fade: ${error.message}` }] };
    }
  }

  private async addTransition(transition: string, betweenClip: number) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});

      // Step 1: Open the Transitions sidebar via the nav button
      await this.clickSidebarNav(page, "Transitions");
      await sleep(3000);

      // Step 2: Click the "Add transition" zone between the specified clips.
      // This selects the gap where the transition will go.
      const zoneBox = await page.evaluate((targetIdx) => {
        const zones = document.querySelectorAll('[aria-label="Add transition"]');
        if (targetIdx >= zones.length) return null;
        const el = zones[targetIdx] as HTMLElement;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, betweenClip);

      if (!zoneBox) {
        throw new Error(`No transition dropzone found between clip ${betweenClip} and clip ${betweenClip + 1}. Make sure there are at least ${betweenClip + 2} clips on the timeline.`);
      }

      // Real mouse click on the zone (not evaluate click — that doesn't trigger React handlers)
      await page.mouse.click(zoneBox.x, zoneBox.y);
      await sleep(2000);

      // Step 3: Click the transition button in the sidebar — same as clicking "Add to timeline" for media
      const transBtn = page.locator(`button[aria-label="${transition}"]`).first();
      const transBox = await transBtn.boundingBox();
      if (!transBox) {
        throw new Error(`Transition "${transition}" not found in the sidebar.`);
      }
      await page.mouse.click(transBox.x + transBox.width / 2, transBox.y + transBox.height / 2);
      await sleep(3000);

      // Verify the transition was added — wait a bit longer and check
      await sleep(2000);
      const added = await page.evaluate(() => {
        const tl = document.querySelector('[aria-label="Timeline"]');
        if (!tl) return false;
        // Check for transition elements (data-testid="transition" or aria-label containing "Transition")
        const transitions = tl.querySelectorAll('[data-testid="transition"]');
        if (transitions.length > 0) return true;
        // Fallback: check if any element has aria-label mentioning a transition type
        const allEls = tl.querySelectorAll("*");
        for (const el of allEls) {
          const aria = el.getAttribute("aria-label") || "";
          if (aria.includes("Transition.") || aria.includes("Cross fade") || aria.includes("transition type")) {
            return true;
          }
        }
        return false;
      });

      // Go back to My media sidebar
      await this.clickSidebarNav(page, "My media");
      await sleep(1500);

      return {
        content: [
          {
            type: "text",
            text: added
              ? `Added transition "${transition}" between clip ${betweenClip} and clip ${betweenClip + 1}.`
              : `Attempted to add transition "${transition}" between clip ${betweenClip} and clip ${betweenClip + 1}, but could not verify it was added. Please check the timeline.`,
          },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to add transition: ${error.message}` }] };
    }
  }

  private async addText(text: string, style: string) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});

      // Open the Text sidebar via the nav button
      await this.clickSidebarNav(page, "Text");
      await sleep(3000);

      // Click the "Add <style> to timeline" button — this adds the text clip
      // to the timeline without needing a drag-and-drop.
      const addBtn = page.locator(`button[aria-label="Add ${style} to timeline"]`).first();
      const btnBox = await addBtn.boundingBox().catch(() => null);
      if (!btnBox) {
        throw new Error(`Text style "${style}" not found. Use list_options to see available styles.`);
      }
      // Use mouse.click for a real click event (evaluate click doesn't trigger React handlers)
      await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
      await sleep(3000);

      // The text clip is now on the timeline and selected.
      // The stage shows "Add your text here" — we need to edit it.
      // Double-click the text on the stage to enter edit mode, then type.
      const stage = page.locator('[aria-label="Stage"]');
      // Find the text element on the stage and double-click it
      const textElPos = await page.evaluate(() => {
        const stage = document.querySelector('[aria-label="Stage"]');
        if (!stage) return null;
        // Look for the text overlay element on the stage
        const textEls = stage.querySelectorAll('[contenteditable], [role="textbox"], p, span, div');
        for (const el of textEls) {
          const text = el.textContent || "";
          if (text.includes("Add your text") || text.includes("Add text") || text.includes("Your text")) {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        // Fallback: look for any element in the center of the stage
        const stageRect = stage.getBoundingClientRect();
        return { x: stageRect.x + stageRect.width / 2, y: stageRect.y + stageRect.height / 2 };
      });

      if (textElPos) {
        // Double-click to enter text edit mode
        await page.mouse.click(textElPos.x, textElPos.y, { clickCount: 2 });
        await sleep(1000);

        // Select all existing text and replace with our text
        await page.keyboard.press("Control+a");
        await sleep(200);
        await page.keyboard.type(text);
        await sleep(500);
        // Press Escape to exit edit mode
        await page.keyboard.press("Escape");
        await sleep(1000);
      }

      // Go back to My media sidebar
      await this.clickSidebarNav(page, "My media");
      await sleep(1500);

      return {
        content: [
          { type: "text", text: `Added text "${text}" with style "${style}" to the timeline.` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to add text: ${error.message}` }] };
    }
  }

  private async setDuration(seconds: number, clipIndex?: number) {
    const page = await this.requirePage();
    try {
      await page.bringToFront().catch(() => {});

      if (clipIndex !== undefined) {
        await this.selectClipByIndex(page, clipIndex);
      }

      // Click the "Edit duration" button on the stage toolbar
      const durBtn = page.getByRole("button", { name: "Edit duration" });
      await durBtn.click({ timeout: 10000 }).catch(() => {});
      await sleep(500);

      // An input should appear — type the new duration
      const durInput = page.locator('input[aria-label*="duration" i], input[aria-label*="Duration" i]').first();
      const inputVisible = await durInput.isVisible().catch(() => false);

      if (inputVisible) {
        await durInput.fill(String(seconds));
        await page.keyboard.press("Enter");
        await sleep(1000);
      } else {
        // Fallback: the duration button text shows current duration like "04.00s"
        // Click it and type directly
        await page.keyboard.press("Control+a");
        await page.keyboard.type(String(seconds));
        await page.keyboard.press("Enter");
        await sleep(1000);
      }

      return {
        content: [
          { type: "text", text: `Set duration to ${seconds}s for clip ${clipIndex ?? "(selected)"}.` },
        ],
      };
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to set duration: ${error.message}` }] };
    }
  }

  private async listOptions() {
    return {
      content: [
        {
          type: "text",
          text: [
            "=== Clipchamp Creative Options ===",
            "",
            `FILTERS (${VALID_FILTERS.length}): ${VALID_FILTERS.join(", ")}`,
            "",
            `EFFECTS (${VALID_EFFECTS.length}): ${VALID_EFFECTS.join(", ")}`,
            "",
            `TRANSITIONS (${VALID_TRANSITIONS.length}): ${VALID_TRANSITIONS.join(", ")}`,
            "",
            `TEXT STYLES (${VALID_TEXT_STYLES.length}): ${VALID_TEXT_STYLES.join(", ")}`,
            "",
            "COLOR ADJUSTMENTS: Exposure, Contrast, Saturation, Temperature, Transparency (range -100 to 100, 0=default)",
            "",
            "ASPECT RATIOS: 16:9, 9:16, 1:1, 4:3, 4:5, 21:9, 2:3",
            "",
            "EXPORT QUALITIES: 480p, 720p, 1080p, 4k",
          ].join("\n"),
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
