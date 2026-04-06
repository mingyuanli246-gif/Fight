import { useState } from "react";
import { ThemeProvider } from "../features/theme/ThemeProvider";
import AppShell from "./layout/AppShell";
import type { AppSection } from "./sections";

function App() {
  const [currentSection, setCurrentSection] = useState<AppSection>("notebooks");

  return (
    <ThemeProvider>
      <AppShell
        currentSection={currentSection}
        onSectionChange={setCurrentSection}
      />
    </ThemeProvider>
  );
}

export default App;
