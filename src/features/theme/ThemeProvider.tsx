import {
  createContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { loadAppSettings, saveAppSettings } from "../settings/commands";
import type { ThemeName } from "./types";

export interface ThemeContextValue {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setTheme] = useState<ThemeName>("blue");
  const isMountedRef = useRef(true);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    isMountedRef.current = true;

    void (async () => {
      try {
        const settings = await loadAppSettings();

        if (isMountedRef.current) {
          setTheme(settings.theme);
        }
      } catch (error) {
        console.error("[theme] 读取持久化主题失败", error);
      }
    })();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  function updateTheme(nextTheme: ThemeName) {
    setTheme(nextTheme);

    void saveAppSettings({ theme: nextTheme }).catch((error) => {
      console.error("[theme] 保存主题设置失败", error);
    });
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme: updateTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
