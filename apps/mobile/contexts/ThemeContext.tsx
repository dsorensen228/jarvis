import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

const THEME_KEY = '@jarvis_app/theme';

export type ColorScheme = 'light' | 'dark';

const darkColors = {
  background: '#000000',
  surface: '#0d0814',
  /** Specialist system messages: darker than Jarvis (surface) */
  surfaceAgentMessage: '#120b1d',
  surfaceElevated: '#181022',
  accent: '#7b4dff',
  accentMuted: '#9a7cff',
  text: '#e4ddea',
  textMuted: '#9f93b1',
  border: '#241935',
  borderLight: '#38264f',
  error: '#ff6b7a',
};

const lightColors = {
  background: '#f3f1f7',
  surface: '#ffffff',
  surfaceAgentMessage: '#ece8f2',
  surfaceElevated: '#faf9fc',
  accent: '#6f43f5',
  accentMuted: '#5b3adb',
  text: '#1a1426',
  textMuted: '#6b627c',
  border: '#e0dae8',
  borderLight: '#efeaf5',
  error: '#c9364a',
};

export const themeColors = {
  dark: darkColors,
  light: lightColors,
};

interface ThemeContextValue {
  colorScheme: ColorScheme;
  colors: typeof darkColors;
  setColorScheme: (scheme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>('dark');

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark') {
        setColorSchemeState(stored);
      }
    });
  }, []);

  const setColorScheme = useCallback((scheme: ColorScheme) => {
    setColorSchemeState(scheme);
    AsyncStorage.setItem(THEME_KEY, scheme);
  }, []);

  const value: ThemeContextValue = {
    colorScheme,
    colors: themeColors[colorScheme],
    setColorScheme,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
