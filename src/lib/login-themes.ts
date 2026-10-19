export type CampaignMotif = 'ribbon' | 'flower' | 'confetti' | 'flags' | 'sun' | 'star';

export interface LoginTheme {
  month: number;
  name: string;
  title: string;
  accent: string;
  accentSoft: string;
  accentInk: string;
  motif: CampaignMotif;
  message: string;
}

/** The Brazilian calendar changes the welcome screen without changing Ecoplast's identity. */
export const LOGIN_THEMES: readonly LoginTheme[] = [
  { month: 1, name: 'Janeiro', title: 'Janeiro Branco', accent: '#faf7ef', accentSoft: '#dbe6db', accentInk: '#263c33', motif: 'sun', message: 'Um novo começo também é uma oportunidade de cuidar de si. Escuta e acolhimento fazem a diferença.' },
  { month: 2, name: 'Fevereiro', title: 'Carnaval', accent: '#ffb99b', accentSoft: '#f8dc7f', accentInk: '#6c392a', motif: 'confetti', message: 'Alegria combina com respeito, responsabilidade e cuidado. Que a celebração seja boa para todos.' },
  { month: 3, name: 'Março', title: 'Mês da Mulher', accent: '#e8b1d7', accentSoft: '#f3d9e9', accentInk: '#62364f', motif: 'flower', message: 'Respeito, reconhecimento e oportunidades. Valorizar as mulheres é um compromisso para todos os dias.' },
  { month: 4, name: 'Abril', title: 'Abril Azul', accent: '#9dcefa', accentSoft: '#d7eafb', accentInk: '#284f74', motif: 'flower', message: 'Cada pessoa tem sua forma de perceber o mundo. Informação, respeito e inclusão aproximam.' },
  { month: 5, name: 'Maio', title: 'Maio Amarelo', accent: '#f1d36d', accentSoft: '#f9e9ae', accentInk: '#66501b', motif: 'ribbon', message: 'No trânsito, cada escolha importa. Atenção, gentileza e responsabilidade protegem vidas.' },
  { month: 6, name: 'Junho', title: 'Festa Junina', accent: '#ffc08c', accentSoft: '#f5dc98', accentInk: '#6b4027', motif: 'flags', message: 'Tempo de celebrar nossas tradições e os encontros que fortalecem a equipe. Bom São João!' },
  { month: 7, name: 'Julho', title: 'Julho Amarelo', accent: '#e9cf72', accentSoft: '#f7e9b6', accentInk: '#66501b', motif: 'ribbon', message: 'Informação e prevenção caminham juntas. Reserve um tempo para cuidar da sua saúde.' },
  { month: 8, name: 'Agosto', title: 'Agosto Lilás', accent: '#c3b1ed', accentSoft: '#e4d9f8', accentInk: '#51406b', motif: 'ribbon', message: 'Respeito e acolhimento fazem parte de um ambiente seguro. Pelo direito de toda mulher viver sem violência.' },
  { month: 9, name: 'Setembro', title: 'Setembro Amarelo', accent: '#f5d86c', accentSoft: '#fbecb3', accentInk: '#66501b', motif: 'ribbon', message: 'Escutar com atenção e acolher sem julgamento são formas de cuidado. Sua vida importa.' },
  { month: 10, name: 'Outubro', title: 'Outubro Rosa', accent: '#ef9ebc', accentSoft: '#f7d6e3', accentInk: '#6f354b', motif: 'ribbon', message: 'Informação, acolhimento e prevenção. Cuidar de você também é prioridade.' },
  { month: 11, name: 'Novembro', title: 'Novembro Azul', accent: '#91bdf0', accentSoft: '#d4e6fa', accentInk: '#2d527d', motif: 'ribbon', message: 'Cuidar da saúde também é um gesto de responsabilidade. Informação e prevenção fazem parte dessa escolha.' },
  { month: 12, name: 'Dezembro', title: 'Natal', accent: '#e8cc85', accentSoft: '#f8eac7', accentInk: '#655025', motif: 'star', message: 'Que a união e a gratidão acompanhem o fim de mais um ano. Boas festas para você e sua família!' },
];

const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', month: 'numeric' });

export function loginThemeForDate(date = new Date()): LoginTheme {
  const month = Number(monthFormatter.format(date));
  return LOGIN_THEMES[month - 1];
}
