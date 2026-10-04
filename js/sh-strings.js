// Localized strings for the StarHermit account controls (sign-in, invite,
// player chip). Same nine locales and picker as the Graphics panel.
import { pickLocale } from './gfx-strings.js';

const en = {
  signIn: 'Sign in with StarHermit',
  invite: 'Invite a friend',
  copied: 'Invite link copied',
  copyFailed: 'Could not copy the invite link',
  signedOut: 'Signed out of StarHermit — progress keeps saving on this device',
  playingAs: 'Playing as {name}',
};
const es = {
  signIn: 'Iniciar sesión con StarHermit',
  invite: 'Invitar a un amigo',
  copied: 'Enlace de invitación copiado',
  copyFailed: 'No se ha podido copiar el enlace de invitación',
  signedOut: 'Se ha cerrado la sesión de StarHermit: el progreso se sigue guardando en este dispositivo',
  playingAs: 'Jugando como {name}',
};
const es419 = {
  ...es,
  copyFailed: 'No se pudo copiar el enlace de invitación',
  signedOut: 'Se cerró la sesión de StarHermit: el progreso se sigue guardando en este dispositivo',
};
const fr = {
  signIn: 'Se connecter avec StarHermit',
  invite: 'Inviter un ami',
  copied: 'Lien d’invitation copié',
  copyFailed: 'Impossible de copier le lien d’invitation',
  signedOut: 'Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil',
  playingAs: 'Vous jouez en tant que {name}',
};
const frCA = { ...fr, signedOut: 'Déconnecté de StarHermit — la progression reste sauvegardée sur cet appareil' };

export const SH_STRINGS = {
  'en-US': en,
  'en-GB': en,
  'es-419': es419,
  'es-ES': es,
  'de-DE': {
    signIn: 'Mit StarHermit anmelden',
    invite: 'Freund einladen',
    copied: 'Einladungslink kopiert',
    copyFailed: 'Einladungslink konnte nicht kopiert werden',
    signedOut: 'Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert',
    playingAs: 'Angemeldet als {name}',
  },
  'fr-FR': fr,
  'fr-CA': frCA,
  'pt-BR': {
    signIn: 'Entrar com StarHermit',
    invite: 'Convidar um amigo',
    copied: 'Link de convite copiado',
    copyFailed: 'Não foi possível copiar o link de convite',
    signedOut: 'Você saiu do StarHermit — o progresso continua salvo neste dispositivo',
    playingAs: 'Jogando como {name}',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit',
    invite: 'Invita un amico',
    copied: 'Link di invito copiato',
    copyFailed: 'Impossibile copiare il link di invito',
    signedOut: 'Disconnesso da StarHermit: i progressi restano salvati su questo dispositivo',
    playingAs: 'Giochi come {name}',
  },
};

export function shStrings(langs) {
  return SH_STRINGS[pickLocale(langs)] || en;
}
