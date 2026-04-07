export type MathDisplayMode = "inline" | "block";
export type MathNodeName = "inlineMath" | "blockMath";

export const INLINE_MATH_NODE_NAME: MathNodeName = "inlineMath";
export const BLOCK_MATH_NODE_NAME: MathNodeName = "blockMath";
export const NOTE_MATH_ATTRIBUTE = "data-note-math";
export const NOTE_MATH_LATEX_ATTRIBUTE = "data-latex";
export const NOTE_MATH_SELECTOR = `[${NOTE_MATH_ATTRIBUTE}]`;

export function sanitizeMathLatex(value: string) {
  return value.trim();
}

export function getMathHtmlTag(displayMode: MathDisplayMode) {
  return displayMode === "inline" ? "span" : "div";
}

export function getMathNodeName(displayMode: MathDisplayMode): MathNodeName {
  return displayMode === "inline"
    ? INLINE_MATH_NODE_NAME
    : BLOCK_MATH_NODE_NAME;
}

export function getMathDisplayModeFromNodeName(
  nodeName: string,
): MathDisplayMode | null {
  if (nodeName === INLINE_MATH_NODE_NAME) {
    return "inline";
  }

  if (nodeName === BLOCK_MATH_NODE_NAME) {
    return "block";
  }

  return null;
}

export function buildMathDataAttributes(
  displayMode: MathDisplayMode,
  latex: string,
) {
  const normalizedLatex = sanitizeMathLatex(latex);

  return {
    [NOTE_MATH_ATTRIBUTE]: displayMode,
    [NOTE_MATH_LATEX_ATTRIBUTE]: normalizedLatex,
  };
}

export function readMathLatexFromElement(element: HTMLElement) {
  return sanitizeMathLatex(
    element.getAttribute(NOTE_MATH_LATEX_ATTRIBUTE) ?? element.textContent ?? "",
  );
}
