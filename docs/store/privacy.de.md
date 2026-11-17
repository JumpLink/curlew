# Datenschutzerklärung

Curlew ist ein Messenger, der auf deinem eigenen Computer läuft. Es gibt keinen Curlew-Server,
also niemanden bei Curlew, der deine Daten empfangen könnte. Diese Seite sagt, was die App
speichert, wohin sie sich verbindet und was sie nie tut. Die App ist quelloffen
([github.com/JumpLink/curlew](https://github.com/JumpLink/curlew)); jede Aussage unten lässt sich
im Code nachprüfen, die technischen Details stehen in
[`docs/privacy/`](https://github.com/JumpLink/curlew/tree/main/docs/privacy).

## Was Curlew macht

Curlew führt deine Mails und deine Chats von Telegram, Signal, WhatsApp, Matrix und XMPP in einer
Liste zusammen. Dafür meldet es sich an den Konten an, die **du** hinzufügst, und zeigt, was
diese Dienste liefern.

## Keine Telemetrie, kein Curlew-Server

- Curlew schickt keine Nutzungsdaten, Absturzberichte oder Statistiken irgendwohin und hat kein
  eigenes Benutzerkonto.
- Es spricht nur mit den Servern der Konten, die du hinzufügst: deinem Mail-Anbieter (IMAP und
  SMTP), deinem Matrix-Homeserver, deinem XMPP-Server sowie den Diensten von Signal, Telegram und
  WhatsApp.
- Die Messenger-Dienste und dein Mail-Anbieter verarbeiten deine Daten nach ihren eigenen
  Datenschutzerklärungen. Curlew hat darauf keinen Einfluss.

## Was auf deinem Computer gespeichert wird

- **Der Index**: die Nachrichten deiner Konten (Mail-Kopfzeilen und Klartext-Inhalte,
  Chat-Nachrichten) in einer lokalen Datenbank unter `$XDG_DATA_HOME/curlew/`, nur für dich
  lesbar. Sie wird nie hochgeladen.
- **Sitzungen und Passwörter**: die Anmeldesitzungen der Chat-Konten und die Passwörter von
  XMPP- und Mail-Konten, die du in Curlew eingibst, liegen in Dateien, die nur du lesen kannst,
  im selben Ordner. Mail-Konten aus den GNOME-Online-Konten (Linux) liest Curlew bei Bedarf aus
  dem System; diese Zugangsdaten speichert es nicht.
- **Einstellungen**: deine Entscheidungen (aktivierte Konten, akzeptierte Hinweise,
  Zugriffsregeln für Agenten) stehen in `$XDG_CONFIG_HOME/curlew/config.json`.
- **Downloads**: Anhänge, die du speicherst, landen in deinem Download-Ordner.

Du kannst all das löschen, indem du diese Ordner entfernst. Eine Kopie aus dem Index zu
entfernen löscht die Nachricht nicht bei dem Dienst, von dem sie kommt.

## Wohin die App sich außer zu deinen Konten verbindet

- **Suche nach Mail-Servern.** Wenn du ein Mail-Konto über die Adresse hinzufügst, sucht Curlew
  die Servereinstellungen: Es fragt `autoconfig.<deine Mail-Domain>`,
  `<deine Mail-Domain>/.well-known/autoconfig` und die öffentliche Konfigurationsdatenbank von
  Mozilla Thunderbird (`autoconfig.thunderbird.net`) ab. Diese Anfragen enthalten die Domain der
  eingegebenen Adresse und nichts sonst. Solange du kein Mail-Konto hinzufügst, passiert das
  nicht.
- **Links.** Links, die du anklickst, öffnen sich in deinem eigenen Browser oder einer App;
  Curlew lädt sie nicht selbst. Die Schaltfläche „Link öffnen“ beim Verknüpfen von Signal
  übergibt den Link an eine andere App auf deinem Gerät.

## KI-Assistenten (standardmäßig aus)

Curlew kann deine Nachrichten über einen lokalen MCP-Server (`curlew mcp`) einem KI-Assistenten
anbieten, aber nur, wenn du KI in den Einstellungen einschaltest. Standardmäßig ist sie aus;
solange sie aus ist, wird jede Anfrage eines Agenten abgelehnt. Ist sie an, spricht der Server
mit dem Assistenten auf deinem eigenen Computer über Standardeingabe und -ausgabe, nicht über
das Netzwerk, und du bestimmst pro Konto und Kontakt, ob der Assistent lesen, senden darf oder
dich fragen muss. Welchen Assistenten du verbindest und was er mit dem Gelesenen macht,
bestimmt dessen Anbieter, nicht Curlew.

## Deine Rechte und Kontakt

Du kannst deine Daten selbst einsehen, exportieren und löschen, weil sie auf deinem Computer
liegen. Bei Fragen zu dieser Erklärung schreibe an pascal@jumplink.eu. Der Verantwortliche steht
im [Impressum](https://jumplink.eu/curlew/de/legal-notice/).
