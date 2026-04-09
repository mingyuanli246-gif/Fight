import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { searchNotes } from "../../features/notebooks/repository";
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

function normalizeQuery(value: string) {
  return value.trim().replace(/\s+/g, " ");
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

export function GlobalSearch({
  onOpenResult,
  variant = "topbar",
  rootClassName,
  boxClassName,
  rootStyle,
  boxStyle,
}: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSearchResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const requestVersionRef = useRef(0);

  const normalizedQuery = useMemo(() => normalizeQuery(query), [query]);
  const shouldShowPanel = normalizedQuery.length > 0;

  useEffect(() => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    if (!normalizedQuery) {
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
          const searchResult = await searchNotes(normalizedQuery, SEARCH_LIMIT);

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
  }, [normalizedQuery]);

  function handleOpenResult(result: NoteSearchResult) {
    setQuery("");
    setResults([]);
    setErrorMessage(null);
    setIsSearching(false);
    onOpenResult({
      noteId: result.noteId,
      notebookId: result.notebookId,
      highlightQuery: normalizedQuery,
      highlightExcerpt: result.excerpt,
      source: "global-search",
    });
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
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
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
                    onClick={() => handleOpenResult(result)}
                  >
                    <span className={styles.resultTitle}>{result.title}</span>
                    <span className={styles.resultPath}>{buildPath(result)}</span>
                    <span className={styles.resultExcerpt}>{result.excerpt}</span>
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
