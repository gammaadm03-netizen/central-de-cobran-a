import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { loginThemeForDate } from '../lib/login-themes';
import CampaignSymbol from './CampaignSymbol';

export function useMonthlyTheme() {
  const [theme, setTheme] = useState(() => loginThemeForDate());
  useEffect(() => {
    const updateTheme = () => setTheme(loginThemeForDate());
    const updateWhenVisible = () => { if (document.visibilityState === 'visible') updateTheme(); };
    const interval = window.setInterval(updateTheme, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', updateWhenVisible);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', updateWhenVisible); };
  }, []);
  return theme;
}

export default function LoginWelcome({ version, brand }: { version: string; brand: ReactNode }) {
  const theme = useMonthlyTheme();
  const colors = {
    '--login-accent': theme.accent,
    '--login-accent-soft': theme.accentSoft,
    '--login-accent-ink': theme.accentInk,
  } as CSSProperties;
  return <section className="login-intro" data-month={theme.month} data-motif={theme.motif} style={colors}>
    <header className="login-brand">{brand}</header>
    <div className="login-welcome-body">
      <div className="login-season"><span className="login-month">{theme.name}</span><span className="login-season-title">{theme.title}</span></div>
      <div className="intro-copy"><h1>As informações certas.<br />Em um só lugar.</h1></div>
      <div className="login-art"><CampaignSymbol motif={theme.motif} /></div>
    </div>
    <footer className="login-credit-block"><small className="login-version">Central Financeira · Versão {version}</small><p className="login-credit">Idealizado e projetado por Graziele Pinheiro.</p></footer>
  </section>;
}
