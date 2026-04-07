import katex from "katex";
import { sanitizeMathLatex, type MathDisplayMode } from "./mathSerialization";

export interface MathValidationSuccess {
  status: "valid";
  latex: string;
}

export interface MathValidationFailure {
  status: "invalid";
  latex: string;
  message: string;
}

export type MathValidationResult =
  | MathValidationSuccess
  | MathValidationFailure;

function toKatexDisplayMode(displayMode: MathDisplayMode) {
  return displayMode === "block";
}

function formatKatexErrorMessage(error: unknown) {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "公式语法无效，请检查 LaTeX 源码。";
  }

  return `公式语法无效，请检查 LaTeX 源码：${error.message.replace(/^KaTeX parse error:\s*/i, "")}`;
}

export function renderMathToHtml(
  latex: string,
  displayMode: MathDisplayMode,
) {
  return katex.renderToString(latex, {
    displayMode: toKatexDisplayMode(displayMode),
    output: "htmlAndMathml",
    throwOnError: true,
    strict: "warn",
  });
}

export function validateMathLatex(
  latex: string,
  displayMode: MathDisplayMode,
): MathValidationResult {
  const normalizedLatex = sanitizeMathLatex(latex);

  if (!normalizedLatex) {
    return {
      status: "invalid",
      latex: normalizedLatex,
      message: "公式源码不能为空。",
    };
  }

  try {
    renderMathToHtml(normalizedLatex, displayMode);
    return {
      status: "valid",
      latex: normalizedLatex,
    };
  } catch (error) {
    return {
      status: "invalid",
      latex: normalizedLatex,
      message: formatKatexErrorMessage(error),
    };
  }
}
