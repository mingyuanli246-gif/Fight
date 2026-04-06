import type { ThemeName } from "./types";

export interface ThemeOption {
  name: ThemeName;
  label: string;
  description: string;
  preview: {
    rail: string;
    accent: string;
    background: string;
    surface: string;
  };
}

export const themeOptions: ThemeOption[] = [
  {
    name: "blue",
    label: "蓝白",
    description: "默认主题，适合长时间写作与信息整理。",
    preview: {
      rail: "#1E3A8A",
      accent: "#60A5FA",
      background: "#F8FAFC",
      surface: "#FFFFFF",
    },
  },
  {
    name: "pink",
    label: "粉白",
    description: "轻柔但克制，适合偏灵感型与审阅型场景。",
    preview: {
      rail: "#9D174D",
      accent: "#F472B6",
      background: "#FDF2F8",
      surface: "#FFFDFE",
    },
  },
  {
    name: "red",
    label: "红白",
    description: "强调感更强，适合高注意力与任务聚焦场景。",
    preview: {
      rail: "#991B1B",
      accent: "#F87171",
      background: "#FEF2F2",
      surface: "#FFFCFC",
    },
  },
  {
    name: "yellow",
    label: "黄白",
    description: "更温暖的桌面观感，适合复习与归档浏览。",
    preview: {
      rail: "#92400E",
      accent: "#FBBF24",
      background: "#FFFBEB",
      surface: "#FFFDF7",
    },
  },
];
