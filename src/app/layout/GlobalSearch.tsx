import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { CSSProperties } from "react";
import { searchNotes } from "../../features/notebooks/repository";
import {
  buildExactSearchPattern,
  normalizeSearchQuery,
} from "../../features/notebooks/searchQuery";
import type {
  NoteOpenTarget,
  NoteSearchResult,
} from "../../features/notebooks/types";
import styles from "./GlobalSearch.module.css";

const SEARCH_DEBOUNCE_MS = 280;
const SEARCH_LIMIT = 20;

interface GlobalSearchProps {
  onOpenResult: (target: NoteOpenTarget) => void;
  variant?: "topbar" | "home";
  rootClassName?: string;
  boxClassName?: string;
  rootStyle?: CSSProperties;
  boxStyle?: CSSProperties;
}

function formatDate(value: string) {
  return new Date(value.replace(" ", "T")).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildPath(result: NoteSearchResult) {
  return `${result.notebookName} / ${result.folderName ?? "未归类"}`;
}

function renderHighlightedText(
  value: string,
  query: string,
  highlightClassName: string,
) {
  const pattern = buildExactSearchPattern(query);

  if (!pattern) {
    return value;
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;

  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? -1;
    const content = match[0] ?? "";

    if (start < 0 || content.length === 0) {
      continue;
    }

    if (start > lastIndex) {
      segments.push(value.slice(lastIndex, start));
    }

    segments.push(
      <mark
        key={`${start}-${content}-${segments.length}`}
        className={highlightClassName}
      >
        {value.slice(start, start + content.length)}
      </mark>,
    );
    lastIndex = start + content.length;
  }

  if (segments.length === 0) {
    return value;
  }

  if (lastIndex < value.length) {
    segments.push(value.slice(lastIndex));
  }

  return segments;
}

export function GlobalSearch({
  onOpenResult,
  variant = "topbar",
  rootClassName,
  boxClassName,
  rootStyle,
  boxStyle,
}: GlobalSearchProps) {
  const [inputValue, setInputValue] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [results, setResults] = useState<NoteSearchResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const requestVersionRef = useRef(0);

  const normalizedInputValue = useMemo(
    () => normalizeSearchQuery(inputValue),
    [inputValue],
  );
  const normalizedCommittedQuery = useMemo(
    () => normalizeSearchQuery(committedQuery),
    [committedQuery],
  );
  const shouldShowPanel = normalizedInputValue.length > 0;

  useEffect(() => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    if (!normalizedCommittedQuery) {
      setResults([]);
      setErrorMessage(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setErrorMessage(null);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const searchResult = await searchNotes(
            normalizedCommittedQuery,
            SEARCH_LIMIT,
          );

          if (requestVersion !== requestVersionRef.current) {
            return;
          }

          setResults(searchResult);
        } catch (error) {
          if (requestVersion !== requestVersionRef.current) {
            return;
          }

          setResults([]);
          setErrorMessage(
            error instanceof Error ? error.message : "搜索失败，请稍后重试。",
          );
        } finally {
          if (requestVersion === requestVersionRef.current) {
            setIsSearching(false);
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [normalizedCommittedQuery]);

  function handleOpenResult(result: NoteSearchResult, querySnapshot: string) {
    requestVersionRef.current += 1;
    setInputValue("");
    setCommittedQuery("");
    setResults([]);
    setErrorMessage(null);
    setIsSearching(false);
    setIsComposing(false);
    onOpenResult({
      noteId: result.noteId,
      notebookId: result.notebookId,
      highlightQuery: querySnapshot,
      highlightExcerpt: result.highlightExcerpt,
      source: "global-search",
    });
  }

  function handleResultPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    result: NoteSearchResult,
  ) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleOpenResult(result, normalizedCommittedQuery);
  }

  function handleResultKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    result: NoteSearchResult,
  ) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleOpenResult(result, normalizedCommittedQuery);
  }

  return (
    <div
      className={`${styles.searchRoot} ${
        variant === "home" ? styles.searchRootHome : ""
      } ${rootClassName ?? ""}`}
      style={rootStyle}
    >
      {variant === "home" ? null : (
        <label className={styles.searchLabel} htmlFor="global-note-search">
          全局搜索
        </label>
      )}
      <div
        className={`${styles.searchBox} ${
          variant === "home" ? styles.searchBoxHome : ""
        } ${boxClassName ?? ""}`}
        style={boxStyle}
      >
        <input
          id="global-note-search"
          type="search"
          inputMode="search"
          className={styles.searchInput}
          value={inputValue}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            setInputValue(nextValue);

            if (!isComposing) {
              setCommittedQuery(nextValue);
            }
          }}
          onCompositionStart={() => {
            setIsComposing(true);
          }}
          onCompositionEnd={(event) => {
            const nextValue = event.currentTarget.value;
            setIsComposing(false);
            setInputValue(nextValue);
            setCommittedQuery(nextValue);
          }}
          placeholder="搜索文件标题或正文内容"
          aria-label="全局搜索"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {shouldShowPanel ? (
        <div
          className={`${styles.searchPanel} ${
            variant === "home" ? styles.searchPanelHome : ""
          }`}
        >
          {isSearching ? (
            <div className={styles.panelState}>正在搜索…</div>
          ) : errorMessage ? (
            <div className={styles.panelError}>
              <strong>搜索不可用</strong>
              <span>{errorMessage}</span>
            </div>
          ) : results.length === 0 ? (
            <div className={styles.panelState}>未找到匹配的文件</div>
          ) : (
            <ul className={styles.resultList}>
              {results.map((result) => (
                <li key={result.noteId}>
                  <button
                    type="button"
                    className={styles.resultItem}
                    onPointerDown={(event) => {
                      handleResultPointerDown(event, result);
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onKeyDown={(event) => {
                      handleResultKeyDown(event, result);
                    }}
                  >
                    <span className={styles.resultTitle}>
                      {renderHighlightedText(
                        result.title,
                        normalizedCommittedQuery,
                        styles.resultHighlight,
                      )}
                    </span>
                    <span className={styles.resultPath}>{buildPath(result)}</span>
                    <span className={styles.resultExcerpt}>
                      {renderHighlightedText(
                        result.excerpt,
                        normalizedCommittedQuery,
                        styles.resultHighlight,
                      )}
                    </span>
                    <span className={styles.resultMeta}>
                      更新时间：{formatDate(result.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
