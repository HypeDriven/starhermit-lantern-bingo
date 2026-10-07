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
  expiredTitle: 'Your session expired',
  expiredBody: 'Your StarHermit session has expired, so you have left the hall. Progress keeps saving on this device.',
  relaunch: 'Back to StarHermit',
  notNow: 'Not now',
};
const es = {
  signIn: 'Iniciar sesión con StarHermit',
  invite: 'Invitar a un amigo',
  copied: 'Enlace de invitación copiado',
  copyFailed: 'No se ha podido copiar el enlace de invitación',
  signedOut: 'Se ha cerrado la sesión de StarHermit: el progreso se sigue guardando en este dispositivo',
  playingAs: 'Jugando como {name}',
  expiredTitle: 'Tu sesión ha caducado',
  expiredBody: 'Tu sesión de StarHermit ha caducado y has salido de la sala. El progreso se sigue guardando en este dispositivo.',
  relaunch: 'Volver a StarHermit',
  notNow: 'Ahora no',
};
const es419 = {
  ...es,
  copyFailed: 'No se pudo copiar el enlace de invitación',
  signedOut: 'Se cerró la sesión de StarHermit: el progreso se sigue guardando en este dispositivo',
  expiredTitle: 'Tu sesión expiró',
  expiredBody: 'Tu sesión de StarHermit expiró y saliste de la sala. El progreso se sigue guardando en este dispositivo.',
};
const fr = {
  signIn: 'Se connecter avec StarHermit',
  invite: 'Inviter un ami',
  copied: 'Lien d’invitation copié',
  copyFailed: 'Impossible de copier le lien d’invitation',
  signedOut: 'Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil',
  playingAs: 'Vous jouez en tant que {name}',
  expiredTitle: 'Votre session a expiré',
  expiredBody: 'Votre session StarHermit a expiré : vous avez quitté la salle. La progression reste enregistrée sur cet appareil.',
  relaunch: 'Retour à StarHermit',
  notNow: 'Plus tard',
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
    expiredTitle: 'Deine Sitzung ist abgelaufen',
    expiredBody: 'Deine StarHermit-Sitzung ist abgelaufen, daher hast du den Saal verlassen. Der Fortschritt wird weiter auf diesem Gerät gespeichert.',
    relaunch: 'Zurück zu StarHermit',
    notNow: 'Nicht jetzt',
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
    expiredTitle: 'Sua sessão expirou',
    expiredBody: 'Sua sessão do StarHermit expirou e você saiu do salão. O progresso continua salvo neste dispositivo.',
    relaunch: 'Voltar ao StarHermit',
    notNow: 'Agora não',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit',
    invite: 'Invita un amico',
    copied: 'Link di invito copiato',
    copyFailed: 'Impossibile copiare il link di invito',
    signedOut: 'Disconnesso da StarHermit: i progressi restano salvati su questo dispositivo',
    playingAs: 'Giochi come {name}',
    expiredTitle: 'La tua sessione è scaduta',
    expiredBody: 'La tua sessione StarHermit è scaduta, quindi hai lasciato la sala. I progressi restano salvati su questo dispositivo.',
    relaunch: 'Torna a StarHermit',
    notNow: 'Non ora',
  },
};

export function shStrings(langs) {
  return SH_STRINGS[pickLocale(langs)] || en;
}
