import { tool } from "@opencode-ai/plugin"
import { Sandbox } from "@e2b/desktop"

let sandbox: Sandbox | null = null

export const create = tool({
  description: "Create a new E2B cloud desktop sandbox. Call this first before any other e2b operations.",
  args: {
    resolution: tool.schema
      .tuple([tool.schema.number(), tool.schema.number()])
      .optional()
      .describe("Screen resolution [width, height], e.g. [1920, 1080]"),
  },
  async execute(args) {
    if (sandbox) {
      await sandbox.kill()
      sandbox = null
    }
    sandbox = await Sandbox.create({
      resolution: args.resolution ?? [1280, 720],
    })
    return `Sandbox created: ${sandbox.sandboxId}`
  },
})

export const screenshot = tool({
  description: "Take a screenshot of the E2B desktop sandbox. Returns the image as base64-encoded PNG. Requires sandbox to be created first.",
  args: {},
  async execute() {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    const image = await sandbox.screenshot()
    const base64 = Buffer.from(image).toString("base64")
    return `data:image/png;base64,${base64}`
  },
})

export const click = tool({
  description: "Left-click at the given coordinates in the E2B desktop sandbox. If no coordinates given, clicks at current mouse position.",
  args: {
    x: tool.schema.number().optional().describe("X coordinate"),
    y: tool.schema.number().optional().describe("Y coordinate"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.leftClick(args.x, args.y)
    return `Clicked at ${args.x ?? "current"}, ${args.y ?? "current"}`
  },
})

export const double_click = tool({
  description: "Double-click at the given coordinates in the E2B desktop sandbox.",
  args: {
    x: tool.schema.number().optional().describe("X coordinate"),
    y: tool.schema.number().optional().describe("Y coordinate"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.doubleClick(args.x, args.y)
    return `Double-clicked at ${args.x ?? "current"}, ${args.y ?? "current"}`
  },
})

export const right_click = tool({
  description: "Right-click at the given coordinates in the E2B desktop sandbox.",
  args: {
    x: tool.schema.number().optional().describe("X coordinate"),
    y: tool.schema.number().optional().describe("Y coordinate"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.rightClick(args.x, args.y)
    return `Right-clicked at ${args.x ?? "current"}, ${args.y ?? "current"}`
  },
})

export const move = tool({
  description: "Move the mouse cursor to the given coordinates in the E2B desktop sandbox.",
  args: {
    x: tool.schema.number().describe("X coordinate"),
    y: tool.schema.number().describe("Y coordinate"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.moveMouse(args.x, args.y)
    return `Moved mouse to ${args.x}, ${args.y}`
  },
})

export const scroll = tool({
  description: "Scroll the mouse wheel in the E2B desktop sandbox.",
  args: {
    direction: tool.schema
      .enum(["up", "down"])
      .optional()
      .describe("Scroll direction, defaults to down"),
    amount: tool.schema.number().optional().describe("Scroll amount in pixels, defaults to 10"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.scroll(args.direction ?? "down", args.amount ?? 10)
    return `Scrolled ${args.direction ?? "down"} by ${args.amount ?? 10}`
  },
})

export const type = tool({
  description: "Type text at the current cursor position in the E2B desktop sandbox.",
  args: {
    text: tool.schema.string().describe("The text to type"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.write(args.text)
    return `Typed: ${args.text}`
  },
})

export const press = tool({
  description: "Press a key or key combination in the E2B desktop sandbox (e.g. 'enter', 'ctrl+c').",
  args: {
    key: tool.schema.string().describe("Key name or combination like 'enter', 'ctrl+c', 'backspace'"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    const keys = args.key.includes("+") ? args.key.split("+") : args.key
    await sandbox.press(keys)
    return `Pressed: ${args.key}`
  },
})

export const drag = tool({
  description: "Drag the mouse from one position to another in the E2B desktop sandbox.",
  args: {
    fromX: tool.schema.number().describe("Starting X coordinate"),
    fromY: tool.schema.number().describe("Starting Y coordinate"),
    toX: tool.schema.number().describe("Ending X coordinate"),
    toY: tool.schema.number().describe("Ending Y coordinate"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.drag([args.fromX, args.fromY], [args.toX, args.toY])
    return `Dragged from ${args.fromX},${args.fromY} to ${args.toX},${args.toY}`
  },
})

export const shell = tool({
  description: "Run a shell command in the E2B desktop sandbox.",
  args: {
    command: tool.schema.string().describe("The shell command to run"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    const result = await sandbox.commands.run(args.command)
    return result.stdout || result.stderr || "(no output)"
  },
})

export const stream = tool({
  description: "Get a URL to view the E2B desktop sandbox in a web browser. Password-protected by default.",
  args: {
    viewOnly: tool.schema
      .boolean()
      .optional()
      .describe("If true, the stream is view-only (no user interaction)"),
  },
  async execute() {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.stream.start({ requireAuth: true })
    const authKey = sandbox.stream.getAuthKey()
    const url = sandbox.stream.getUrl({ authKey, viewOnly: false })
    return `Stream URL: ${url}\nAuth key: ${authKey}`
  },
})

export const launch = tool({
  description: "Launch an application in the E2B desktop sandbox (e.g. 'google-chrome', 'firefox', 'code').",
  args: {
    application: tool.schema.string().describe("Application name to launch"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.launch(args.application)
    return `Launched: ${args.application}`
  },
})

export const wait = tool({
  description: "Wait for a specified number of milliseconds.",
  args: {
    ms: tool.schema.number().describe("Milliseconds to wait"),
  },
  async execute(args) {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    await sandbox.wait(args.ms)
    return `Waited ${args.ms}ms`
  },
})

export const kill = tool({
  description: "Kill/destroy the E2B desktop sandbox.",
  args: {},
  async execute() {
    if (!sandbox) return "No sandbox to kill."
    await sandbox.kill()
    const id = sandbox.sandboxId
    sandbox = null
    return `Sandbox killed: ${id}`
  },
})

export const cursor_position = tool({
  description: "Get the current cursor position in the E2B desktop sandbox.",
  args: {},
  async execute() {
    if (!sandbox) return "No sandbox. Use e2b_create first."
    const pos = await sandbox.getCursorPosition()
    return `Cursor at ${pos.x}, ${pos.y}`
  },
})