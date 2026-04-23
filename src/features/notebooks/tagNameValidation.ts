const TAG_NAME_MEANINGFUL_CONTENT_PATTERN =
  /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

export const MAX_TAG_NAME_UNITS = 12;

interface ValidateTagNameOptions {
  existingNames?: Iterable<string>;
}

export function normalizeTagNameInput(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function measureTagNameUnits(value: string) {
  let units = 0;

  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    units += codePoint <= 0x7f ? 1 : 2;
  }

  return units;
}

export function validateTagName(
  rawValue: string,
  options: ValidateTagNameOptions = {},
) {
  const name = normalizeTagNameInput(rawValue);

  if (!name) {
    return {
      name,
      error: "标签名称不能为空",
    };
  }

  if (!TAG_NAME_MEANINGFUL_CONTENT_PATTERN.test(name)) {
    return {
      name,
      error: "标签名称不能只包含标点符号",
    };
  }

  if (measureTagNameUnits(name) > MAX_TAG_NAME_UNITS) {
    return {
      name,
      error: "标签名称最多 6 个单位",
    };
  }

  if (options.existingNames) {
    for (const existingName of options.existingNames) {
      if (normalizeTagNameInput(existingName) === name) {
        return {
          name,
          error: "标签名称已存在",
        };
      }
    }
  }

  return {
    name,
    error: null,
  };
}
