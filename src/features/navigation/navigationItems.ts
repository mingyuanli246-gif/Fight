import type { ComponentType, SVGProps } from "react";
import type { AppSection } from "../../app/sections";
import {
  CalendarIcon,
  NotebookIcon,
  SettingsIcon,
  TagIcon,
  TrashIcon,
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
    key: "tagPlaza",
    label: "标签",
    Icon: TagIcon,
  },
  {
    key: "reviewTasks",
    label: "复习",
    Icon: CalendarIcon,
  },
  {
    key: "trash",
    label: "回收站",
    Icon: TrashIcon,
  },
  {
    key: "settings",
    label: "设置",
    Icon: SettingsIcon,
  },
];
