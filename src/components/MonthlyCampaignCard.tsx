import type { CSSProperties } from 'react';
import CampaignSymbol from './CampaignSymbol';
import { useMonthlyTheme } from './LoginWelcome';

export default function MonthlyCampaignCard() {
  const theme = useMonthlyTheme();
  const colors = {
    '--login-accent': theme.accent,
    '--login-accent-soft': theme.accentSoft,
    '--login-accent-ink': theme.accentInk,
  } as CSSProperties;

  return <aside className="monthly-campaign" aria-label="Campanha do mês" data-month={theme.month} data-motif={theme.motif} style={colors}>
    <CampaignSymbol motif={theme.motif} className="monthly-campaign-symbol" />
    <div className="monthly-campaign-copy">
      <small>Campanha do mês</small>
      <strong>{theme.title}</strong>
      <p>{theme.message}</p>
    </div>
  </aside>;
}
