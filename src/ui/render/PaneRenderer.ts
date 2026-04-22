import type { InteractiveCliBackend } from "../../backends/interactiveCliBackend.ts";

const ANSI = {
  reset: "\u001B[0m",
  black: "\u001B[30m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  cyan: "\u001B[36m",
  bgGreen: "\u001B[42m",
  bgYellow: "\u001B[43m",
  bgBlue: "\u001B[44m",
  bgCyan: "\u001B[46m"
} as const;

export interface RenderLine {
  text: string;
  cursorCol?: number;
  richCells?: StyledRenderCell[];
  richBoundaryCol?: number;
}

interface StyledRenderCell {
  startCol: number;
  width: number;
  text: string;
  style: string;
}

interface TerminalBufferCellLike {
  getWidth(): number;
  getChars(): string;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}

interface TerminalBufferLineLike {
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell?(x: number): TerminalBufferCellLike | undefined;
}

interface TerminalBufferActiveLike {
  baseY: number;
  cursorY: number;
  cursorX: number;
  getLine(y: number): TerminalBufferLineLike | undefined;
}

export function buildPaneLines(options: {
  buffer: TerminalBufferActiveLike;
  backend: InteractiveCliBackend;
  width: number;
  height: number;
  start: number;
  focusActive: boolean;
  recentActivityAt: number;
  now?: number;
}): RenderLine[] {
  const {
    buffer,
    backend,
    width,
    height,
    start,
    focusActive,
    recentActivityAt,
    now = Date.now()
  } = options;
  const lines: RenderLine[] = [];
  const cursorLine = buffer.baseY + buffer.cursorY;
  const cursorCol = buffer.cursorX;
  const cursorIdleForMs = now - recentActivityAt;
  const showSyntheticCursor =
    backend.supportsSyntheticCursorOverlay && cursorIdleForMs >= backend.syntheticCursorOverlayDelayMs;
  const effectiveCursor =
    showSyntheticCursor && focusActive
      ? resolveEffectiveCursorTarget(buffer, backend, width, cursorLine, cursorCol)
      : undefined;

  for (let index = 0; index < height; index += 1) {
    const lineIndex = start + index;
    const line = buffer.getLine(lineIndex);
    const rawText = stripAnsi((line?.translateToString(false) ?? "").replace(/\t/g, "    "));
    const suppressDecorativeRun = backend.id === "gemini" && isSuppressibleGeminiDecorativeLine(rawText);
    const text = suppressDecorativeRun ? "" : sanitizeLine(line?.translateToString(true) ?? "", width);
    const visibleWidth = getDisplayWidth(text);
    const trimmedVisibleWidth = getDisplayWidth(text.replace(/\s+$/u, ""));
    const anchorWidth = trimmedVisibleWidth > 0 ? trimmedVisibleWidth : visibleWidth;
    const activeCursorCol = effectiveCursor?.line === lineIndex ? effectiveCursor.column : cursorCol;
    const anchoredCursorCol =
      backend.anchorsCursorToVisibleTextEnd && anchorWidth > 0 && activeCursorCol >= anchorWidth
        ? anchorWidth
        : activeCursorCol;

    lines.push({
      text,
      richCells: backend.id === "gemini" && !suppressDecorativeRun ? buildStyledCells(line, width) : undefined,
      richBoundaryCol: backend.id === "gemini" && !suppressDecorativeRun ? getStyledBoundaryColumn(line, width) : undefined,
      cursorCol:
        showSyntheticCursor && focusActive && effectiveCursor?.line === lineIndex
          ? Math.min(anchoredCursorCol, Math.max(0, width - 1), visibleWidth)
          : undefined
    });
  }

  return lines;
}

function resolveEffectiveCursorTarget(
  buffer: TerminalBufferActiveLike,
  backend: InteractiveCliBackend,
  width: number,
  cursorLine: number,
  cursorCol: number
): { line: number; column: number } {
  if (backend.id !== "gemini") {
    return { line: cursorLine, column: cursorCol };
  }

  const currentLine = buffer.getLine(cursorLine);
  const placeholderColumn = getGeminiPlaceholderStartColumn(currentLine, width);
  if (placeholderColumn !== undefined) {
    return { line: cursorLine, column: placeholderColumn };
  }

  for (let candidateLine = cursorLine - 1; candidateLine >= Math.max(0, cursorLine - 3); candidateLine -= 1) {
    const candidate = buffer.getLine(candidateLine);
    const candidatePlaceholderColumn = getGeminiPlaceholderStartColumn(candidate, width);
    if (candidatePlaceholderColumn !== undefined) {
      return { line: candidateLine, column: candidatePlaceholderColumn };
    }
  }

  if (lineHasVisibleGeminiContent(currentLine, width)) {
    return { line: cursorLine, column: cursorCol };
  }

  for (let candidateLine = cursorLine - 1; candidateLine >= Math.max(0, cursorLine - 3); candidateLine -= 1) {
    const candidate = buffer.getLine(candidateLine);
    if (!lineHasVisibleGeminiContent(candidate, width)) {
      continue;
    }

    const text = sanitizeLine(candidate?.translateToString(true) ?? "", width);
    const trimmedWidth = getDisplayWidth(text.replace(/\s+$/u, ""));
    const visibleWidth = getDisplayWidth(text);
    const anchorWidth = trimmedWidth > 0 ? trimmedWidth : visibleWidth;
    return { line: candidateLine, column: anchorWidth };
  }

  return { line: cursorLine, column: cursorCol };
}

export function fillRenderLines(count: number, value: string): RenderLine[] {
  return Array.from({ length: count }, () => ({ text: value }));
}

export function formatPaneLine(line: RenderLine | undefined, width: number, focusColor?: string): string {
  if (line?.richCells) {
    return `${ANSI.reset}${renderStyledPaneLine(line, width, focusColor)}${ANSI.reset}`;
  }

  const padded = padPlain(line?.text ?? "", width);
  if (line?.cursorCol === undefined || focusColor === undefined) {
    return `${ANSI.reset}${padded}${ANSI.reset}`;
  }

  return `${ANSI.reset}${highlightCursorColumn(padded, line.cursorCol, focusColor)}${ANSI.reset}`;
}

export function padPlain(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  const visibleWidth = getDisplayWidth(truncated);
  if (visibleWidth >= width) {
    return truncated;
  }

  return `${truncated}${" ".repeat(width - visibleWidth)}`;
}

function sanitizeLine(value: string, width: number): string {
  return truncateToWidth(stripAnsi(value).replace(/\t/g, "    "), width);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function highlightCursorColumn(value: string, column: number, color: string): string {
  const safeColumn = Math.max(0, column);
  let displayWidth = 0;
  let index = 0;

  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    const charWidth = getCharWidth(char);
    if (displayWidth + charWidth > safeColumn) {
      break;
    }
    displayWidth += charWidth;
    index += char.length;
  }

  if (index >= value.length) {
    return value;
  }

  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) {
    return value;
  }

  const char = String.fromCodePoint(codePoint);
  const before = value.slice(0, index);
  const after = value.slice(index + char.length);
  return `${before}${renderCursorCell(char, color)}${ANSI.reset}${after}`;
}

function renderStyledPaneLine(line: RenderLine, width: number, focusColor?: string): string {
  const cells = line.richCells ?? [];
  const styledBoundary = Math.max(0, Math.min(width, line.richBoundaryCol ?? 0));
  const cursorCol = line.cursorCol;
  let output = "";
  let currentStyle = ANSI.reset;
  let currentCol = 0;

  for (const cell of cells) {
    if (currentCol >= width) {
      break;
    }

    const gap = Math.max(0, cell.startCol - currentCol);
    if (gap > 0) {
      output += renderStyledGap(currentCol, gap, cursorCol, focusColor);
      currentCol += gap;
    }

    const cellWidth = Math.min(cell.width, width - currentCol);
    const shouldKeepGeminiCellStyle = cell.startCol < styledBoundary && hasVisibleContentGlyph(cell.text);
    const displayText = shouldKeepGeminiCellStyle ? cell.text : " ".repeat(cellWidth);
    const style =
      cursorCol !== undefined &&
      focusColor !== undefined &&
      cursorCol >= cell.startCol &&
      cursorCol < cell.startCol + cellWidth
        ? cursorCellStyle(cell.text, focusColor)
        : shouldKeepGeminiCellStyle
          ? cell.style
          : ANSI.reset;

    if (style !== currentStyle) {
      output += style;
      currentStyle = style;
    }

    output += displayText;
    currentCol += cellWidth;
  }

  if (currentCol < width) {
    output += renderStyledGap(currentCol, width - currentCol, cursorCol, focusColor);
  }

  return output;
}

function renderStyledGap(
  startCol: number,
  width: number,
  cursorCol: number | undefined,
  focusColor: string | undefined
): string {
  if (width <= 0) {
    return "";
  }

  if (cursorCol === undefined || focusColor === undefined || cursorCol < startCol || cursorCol >= startCol + width) {
    return `${ANSI.reset}${" ".repeat(width)}`;
  }

  const before = " ".repeat(Math.max(0, cursorCol - startCol));
  const after = " ".repeat(Math.max(0, startCol + width - cursorCol - 1));
  return `${ANSI.reset}${before}${renderCursorCell(" ", focusColor)}${ANSI.reset}${after}`;
}

function hasVisibleGlyph(value: string): boolean {
  return /\S/u.test(value);
}

function hasVisibleContentGlyph(value: string): boolean {
  return hasVisibleGlyph(value) && !isDecorativeFrameGlyph(value);
}

function isDecorativeFrameGlyph(value: string): boolean {
  return /^[\u2500-\u257f\u23a0-\u23af]+$/u.test(value);
}

function isDecorativeBlockGlyph(value: string): boolean {
  return /^[\u2580-\u259f]+$/u.test(value);
}

function isSuppressibleGeminiDecorativeLine(value: string): boolean {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length < 8) {
    return false;
  }

  if (!/^[\u2500-\u257f\u2580-\u259f\u23a0-\u23af]+$/u.test(compact)) {
    return false;
  }

  const distinct = new Set([...compact]);
  return distinct.size <= 2 || [...distinct].every((char) => isDecorativeFrameGlyph(char) || isDecorativeBlockGlyph(char));
}

function lineHasVisibleGeminiContent(line: TerminalBufferLineLike | undefined, width: number): boolean {
  const rawText = stripAnsi((line?.translateToString(false) ?? "").replace(/\t/g, "    "));
  if (isSuppressibleGeminiDecorativeLine(rawText)) {
    return false;
  }

  const text = sanitizeLine(line?.translateToString(true) ?? "", width);
  if (getGeminiPlaceholderStartColumnFromText(text) !== undefined) {
    return false;
  }

  return /\S/u.test(text);
}

function getGeminiPlaceholderStartColumn(line: TerminalBufferLineLike | undefined, width: number): number | undefined {
  return getGeminiPlaceholderStartColumnFromText(sanitizeLine(line?.translateToString(true) ?? "", width));
}

function getGeminiPlaceholderStartColumnFromText(text: string): number | undefined {
  const marker = "Type your message or @path/to/file";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const prefix = text.slice(0, markerIndex);
  const prefixWidth = getDisplayWidth(prefix);
  if (prefixWidth <= 0) {
    return 0;
  }

  return Math.max(0, prefixWidth - 1);
}

function buildStyledCells(line: TerminalBufferLineLike | undefined, width: number): StyledRenderCell[] | undefined {
  if (!line?.getCell) {
    return undefined;
  }

  const cells: StyledRenderCell[] = [];

  for (let column = 0; column < width; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }

    const cellWidth = Math.max(1, cell.getWidth() || 1);
    if (cell.getWidth() === 0) {
      continue;
    }

    cells.push({
      startCol: column,
      width: Math.min(cellWidth, width - column),
      text: cell.getChars() || " ".repeat(Math.min(cellWidth, width - column)),
      style: cellStyleToAnsi(cell)
    });
    column += cellWidth - 1;
  }

  return cells;
}

function getStyledBoundaryColumn(line: TerminalBufferLineLike | undefined, width: number): number {
  if (!line?.getCell) {
    return 0;
  }

  let boundary = 0;
  for (let column = 0; column < width; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }

    const cellWidth = Math.max(1, cell.getWidth() || 1);
    if (cell.getWidth() === 0) {
      continue;
    }

    if (hasVisibleContentGlyph(cell.getChars() || "")) {
      boundary = Math.min(width, column + cellWidth);
    }
    column += cellWidth - 1;
  }

  return boundary;
}

function cellStyleToAnsi(cell: TerminalBufferCellLike): string {
  const codes: string[] = [];

  if (cell.isBold()) {
    codes.push("1");
  }
  if (cell.isDim()) {
    codes.push("2");
  }
  if (cell.isItalic()) {
    codes.push("3");
  }
  if (cell.isInvisible()) {
    codes.push("8");
  }
  if (cell.isStrikethrough()) {
    codes.push("9");
  }

  return codes.length > 0 ? `\u001B[${codes.join(";")}m` : ANSI.reset;
}

function cursorBackgroundColor(color: string): string {
  switch (color) {
    case "\u001B[34m":
      return ANSI.bgBlue;
    case "\u001B[32m":
      return ANSI.bgGreen;
    case "\u001B[33m":
      return ANSI.bgYellow;
    case "\u001B[36m":
      return ANSI.bgCyan;
    default:
      return ANSI.bgBlue;
  }
}

function cursorForegroundColor(color: string): string {
  switch (color) {
    case "\u001B[34m":
      return ANSI.blue;
    case "\u001B[32m":
      return ANSI.green;
    case "\u001B[33m":
      return ANSI.yellow;
    case "\u001B[36m":
      return ANSI.cyan;
    default:
      return ANSI.blue;
  }
}

function cursorCellStyle(char: string, color: string): string {
  return /\s/u.test(char) ? `${cursorBackgroundColor(color)}${cursorForegroundColor(color)}` : `${cursorBackgroundColor(color)}${ANSI.black}`;
}

function renderCursorCell(char: string, color: string): string {
  if (/\s/u.test(char)) {
    return `${cursorCellStyle(char, color)}█`;
  }

  return `${cursorCellStyle(char, color)}${char}`;
}

function truncateToWidth(value: string, width: number): string {
  let result = "";
  let consumed = 0;
  for (const char of value) {
    const charWidth = getCharWidth(char);
    if (consumed + charWidth > width) {
      break;
    }
    result += char;
    consumed += charWidth;
  }

  return result;
}

function getDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += getCharWidth(char);
  }

  return width;
}

function getCharWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;

  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    (codePoint >= 0x300 && codePoint <= 0x36f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}
