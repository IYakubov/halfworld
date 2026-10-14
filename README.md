# Turret Duo

A co-op game for **2 players (or solo)** on [Shared Couch](https://sharedcouch.online). One machine gun sits in a sandbag nest in the middle of the screen, and monsters crawl in from every side. **One player turns the gun and the other pulls the trigger.** Neither can do the other's job, so you have to work together.

## How to play
- Open the game on any screen and press **Create game**. Both phones scan the QR code and press **Ready**. A phone alone in the room can press **Play solo**, and then that one phone turns and shoots.
- **Turner:** hold ◀ or ▶ to turn the gun. The whole platform turns with it: the gun, the crank and both men, and the crank wheel spins while it turns. A dial on the phone shows where the gun points.
- **Gunner:** hold the fire button for auto-fire (8 shots/s). Bullets are limited. You start with 80, get +25 after each wave, and can hold up to 99.
- **Ammo crates** drop from some kills (always from a brute). Shoot a crate to collect +20, but it disappears after 9 s.
- **Monsters:** crawlers, fast runners (from wave 3) and big brutes (from wave 2, several hits).
- **Base:** 3 hearts. A monster that reaches the sandbags takes one. When the hearts are gone, the game is over and your score is the waves you held. The best score is kept on the big screen.
- **Swap:** after every wave the roles switch, so both players get to shoot.

## Run locally
```
npm install
npm start        # http://localhost:3000
```

## Shared Couch conventions
- It works behind the front door at any path prefix: asset and socket.io paths are relative, and the QR link is built from `X-Forwarded-Proto/Host/Prefix`.
- **Menu button** on the phone (top-right) and the big screen (bottom-right), or Esc. It opens Resume / Back to lobby / Game catalog, and pausing freezes the game.
- One phone holds one slot (`turretduo_client` in localStorage).
- Everything is drawn on a 2D canvas with synthesised sound and no image or audio files, so it's light enough for a TV browser.

## Socket events
| Event | Direction | Payload |
|---|---|---|
| create_game → game_created | host↔server | → `{code, joinUrl, qrSvg}` |
| join_game / rejoin_game → joined / join_error | phone↔server | `{code, clientId[, slot]}` |
| player_ready / player_solo | phone→server | |
| game_event `lobby_ready_update` | server→all | `{A, B, readyA, readyB}` |
| game_start | server→all | `{players:['A','B']}` or `['A']` |
| ctrl_turn | phone→host | `{slot, dir}` −1 / 0 / 1 |
| ctrl_fire | phone→host | `{slot, on}` |
| ctrl_pick | phone→host | `{slot, index}`, a tapped menu row |
| ctrl_menu | phone→host | toggles pause |
| host_ui | host→phones | `{phase, roles:{A,B}, status, menu, items, focus, wave}` |
| host_state | host→phones (volatile, ~10/s) | `{ang, ammo, max}` |
| host_back_to_lobby → back_to_lobby, host_exit | host→phones | |
