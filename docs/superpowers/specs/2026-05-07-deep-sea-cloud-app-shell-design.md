# Deep Sea Cloud App Shell Redesign

Date: 2026-05-07
Project: Fight local notes app
Scope: Desktop main shell, global tokens, navigation rail, notebook sidebar visual redesign

## Summary

Redesign the app shell into a clear three-zone desktop layout:

- Left: a fixed `64px` deep-blue navigation rail for global section switching
- Middle: a light-gray notebook sidebar for structural navigation
- Right: a white main workspace for reading and editing

The redesign must remove the current all-white card-heavy feel and replace it with a stronger spatial hierarchy based on color transitions:

- deep blue `#1E3A8A`
- cloud gray `#F8FAFC`
- white `#FFFFFF`

The work is visual and structural only. Existing React state, hooks, data flow, section switching, repository logic, and notebook behavior must remain unchanged.

## Goals

1. Establish a classic desktop productivity layout with strong left-to-right hierarchy.
2. Make the rail feel premium and precise through restrained hover and active feedback.
3. Make the notebook sidebar scan quickly with compact text-only rows.
4. Make the main workspace feel cleaner by reducing unnecessary borders and card framing.
5. Keep implementation localized to the requested files and nearby style modules only.

## Non-Goals

- No change to section routing or `onSectionChange` behavior.
- No change to notebook CRUD, sorting, drag-and-drop, save, or persistence logic.
- No redesign of unrelated pages outside the main shell chain.
- No new component architecture or hook refactors.

## Visual Direction

### Spatial hierarchy

Use color, not heavy chrome, to divide regions:

- `NavigationRail`: dark and compact
- `NotebookSidebar`: pale and structural
- `Main workspace`: white and content-first

There should be no border between the rail and the sidebar. The contrast between deep blue and light gray is sufficient.

There should be only one subtle divider between the sidebar and the main workspace:

- `border-right: 1px solid var(--color-border-subtle);`

### Mood

The interface should feel like a professional desktop knowledge tool:

- calm
- precise
- slightly cool
- not decorative
- not glassy
- not card-stacked

## Token System

Update `src/styles/tokens.css` to define the new shell-specific palette:

### Rail tokens

- `--color-rail-bg: #1E3A8A;`
- `--color-rail-icon-default: rgba(255, 255, 255, 0.6);`
- `--color-rail-icon-active: #FFFFFF;`
- `--color-rail-hover-bg: rgba(255, 255, 255, 0.1);`
- `--color-rail-active-bg: rgba(255, 255, 255, 0.2);`

### Sidebar and main area tokens

- `--color-sidebar-bg: #F8FAFC;`
- `--color-main-bg: #FFFFFF;`
- `--color-border-subtle: #E2E8F0;`
- `--text-primary: #1E293B;`
- `--text-secondary: #64748B;`

### Supporting decisions

- Keep `--rail-width: 64px;`
- Keep a system desktop font stack
- Avoid raw color values in component styles when equivalent tokens exist

## App Shell

Files:

- `src/app/layout/AppShell.tsx`
- `src/app/layout/AppShell.module.css`

### Required behavior

- The outer shell stays `height: 100vh`
- The outer shell uses `overflow: hidden`
- Each internal region manages its own scrolling
- The shell itself handles region backgrounds, not nested card wrappers

### Layout rules

- Column 1: rail, fixed `64px`
- Column 2+: content area
- The content area background should support a light-gray sidebar and white main region
- Remove visually heavy panel framing at the app shell layer

### Interaction constraints

- Do not change section-change logic
- Keep immersive notebook detail behavior intact
- Preserve all existing refs and unsaved-change guards

## Navigation Rail

Files:

- `src/features/navigation/NavigationRail.tsx`
- `src/features/navigation/NavigationRail.module.css`

### Structure

Keep the current compact icon-only rail pattern.

### Styling rules

- Background uses `--color-rail-bg`
- Items should not stretch edge-to-edge visually
- Buttons should use internal spacing and `border-radius: 8px`
- Default icon color uses `--color-rail-icon-default`

### Hover state

- Item background uses `--color-rail-hover-bg`
- Icon becomes visually brighter than default

### Active state

- Item background uses `--color-rail-active-bg`
- Icon color becomes `--color-rail-icon-active`
- Add a left-side active indicator using a pseudo-element:
  - width: `3px`
  - color: `#60A5FA`
  - short vertical pill or rounded bar

### Accessibility

- Keep icon-only navigation accessible via hidden text or `aria-label`
- Preserve `aria-current` for the active section
- Preserve keyboard focus visibility in a restrained style suitable for dark UI

## Notebook Sidebar

Files:

- `src/features/notebooks/NotebookSidebar.tsx`
- related selectors in `src/features/notebooks/NotebookWorkspace.module.css`
- if needed, the actual mounted notebooks home/sidebar surface in `src/features/notebooks/NotebookHomeWorkspace.tsx`

### Structure

Use a compact text-first sidebar. Remove visual emphasis on cover thumbnails in the notebook list presentation.

If the current live notebooks view is not actually rendered by `NotebookSidebar.tsx`, apply the same visual rules to the real sidebar implementation without changing business structure.

Current codebase note:

- `NotebookWorkspace.tsx` currently mounts `NotebookHomeWorkspace`
- `NotebookSidebar.tsx` exists but is not currently the primary notebooks home entry in the live render path
- therefore implementation must verify the mounted sidebar surface before assuming `NotebookSidebar.tsx` is the only effective change point

### Container rules

- Background uses `--color-sidebar-bg`
- The sidebar owns the subtle right divider into the main workspace
- The sidebar should feel like a structural surface, not a floating card

### Group labels

- Uppercase
- `11px`
- `font-weight: 600`
- secondary text color

### List item rules

- `padding: 6px 12px;`
- `margin: 2px 8px;`
- `border-radius: 6px;`
- single-line truncation for notebook title
- secondary metadata line in `--text-secondary`

### List item interaction

- Hover uses a slightly darker light-gray surface
- Active uses a slightly stronger light-gray state
- No full-brand blue fills in the sidebar item background
- State changes should animate lightly:
  - `background-color 0.15s ease`
  - `color 0.15s ease`

### Empty state

Use a centered empty state with:

- one short explanatory message
- one ghost-style create action

The empty state should feel quiet and integrated into the sidebar, not like a warning panel.

## Base Styles

File:

- `src/styles/base.css`

### Changes

- Ensure the system font stack is active globally
- Support the new shell backgrounds cleanly
- Keep scroll behavior desktop-friendly
- Use restrained scrollbar styling only if it remains subtle and does not visually fight the new shell hierarchy

## Implementation Notes

1. Prefer local CSS module changes over JSX restructuring.
2. Only adjust markup where needed for accessibility or to support visual hooks like active indicators.
3. Do not remove or alter notebook workflow behaviors.
4. Preserve current hook order, refs, and event handling.
5. Verify the real render path before claiming the sidebar redesign is complete.

## Acceptance Criteria

The redesign is successful when:

1. The left rail is visibly deep blue and visually separate from the rest of the app.
2. The notebook sidebar is visibly light gray and text-first.
3. The main area is visually white and cleaner than the previous card-heavy approach.
4. There is no border between rail and sidebar.
5. There is only a subtle divider between sidebar and main workspace.
6. Rail hover and active states match the specified dark-theme behavior.
7. Sidebar rows feel compact, aligned, and easy to scan.
8. No React logic regression is introduced.
9. TypeScript build still passes.

## Verification

After implementation:

1. Run `npm run typecheck`
2. Run `npm run build`
3. Manually inspect the notebooks shell in desktop viewport
4. Confirm active, hover, empty, and scroll states on rail and sidebar
