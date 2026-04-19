import type { ComponentType, SVGProps } from "react";
import type { AppSection } from "../../app/sections";
import {
  CalendarIcon,
  NotebookIcon,
  SettingsIcon,
  TagIcon,
} from "./NavigationIcons";

export interface NavigationItem {
  key: AppSection;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const navigationItems: NavigationItem[] = [
  {
    key: "notebooks",
    label: "笔记本",
    Icon: NotebookIcon,
  },
  {
    key: "reviewTasks",
    label: "复习任务",
    Icon: CalendarIcon,
  },
  {
    key: "tagPlaza",
    label: "标签广场",
    Icon: TagIcon,
  },
  {
    key: "settings",
    label: "设置",
    Icon: SettingsIcon,
  },
];
