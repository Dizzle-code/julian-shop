# Julian-Shop

Auftragsboard für die Familie: Aufträge erstellen, Julian legt Preis/Status fest, offene Beträge werden pro Person angezeigt.

## Dokploy

1. Create Service -> Compose -> Inhalt von `dokploy-compose.yml` einfügen.
2. `ADMIN_PIN` ändern, deployen.
3. Erreichbar unter `http://<server-ip>:5731`.
4. Optional ohne Port: in Dokploy unter "Domains" `julian.local` -> Service `app`, Port `5731`, HTTPS aus (Avahi-Schritt unten trotzdem nötig).

Updates: Code pushen, in Dokploy neu deployen.

## Starten (ohne Dokploy)

1. In `docker-compose.yml` `ADMIN_PIN` ändern (optional `PAYPAL_ME` = dein paypal.me-Name, dann erscheint bei erledigten Aufträgen ein Bezahl-Link).
2. `docker compose up -d --build`
3. Aufrufen: `http://<server-ip>:5731`

Daten liegen im Docker-Volume `shop-data` (`/data/orders.json`).

## Erreichbar unter julian.local

`.local`-Namen laufen über mDNS (Avahi/Bonjour), nicht über den Router.

1. Auf dem Server (Linux):
   ```bash
   sudo apt install avahi-daemon
   sudo hostnamectl set-hostname julian
   sudo systemctl restart avahi-daemon
   ```
   Danach ist `http://julian.local:5731` im Heimnetz erreichbar.
   (Hostname nicht ändern? Alternativ: `avahi-publish -a -R julian.local <server-ip>` als systemd-Dienst.)
2. Ohne Port (`http://julian.local`): Reverse-Proxy auf Port 80 mitstarten:
   ```bash
   docker compose --profile proxy up -d
   ```
   Nur möglich, wenn Port 80 auf dem Server noch frei ist.

Hinweis: Android-Geräte lösen `.local` teils nicht auf; dort die IP oder einen DNS-Eintrag im Router/Pi-hole nutzen.
