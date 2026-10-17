# Installation Progress — Production Control

An offline application for recording weekly installation progress by building and room.

**[Open the application](https://ricardoscassa.github.io/installation-progress/)**

Open the app online once and wait for **Offline ready**. Import a prepared weekly ZIP and confirm the person recording the work. Keep using the same browser and address to return to saved work.

## Daily work

- Navigate rooms and open one ECS card at a time. Additional ECS are found through the room's typed search.
- Record gates, percentages, comments and optional photos. Field reporting is limited to 90%.
- Review the daily draft and record the supervisor's name. Changes after review require another review.
- Export the daily package, including its complete recovery backup and saved photo bytes. Previous downloads remain available for the active week.

The app records exports; it does not confirm that exported files were received elsewhere.

## Offline storage and recovery

The app caches its required assets and saves records, unfinished editors and photo context on the device. Refreshing or reopening restores saved work. Available storage depends on the browser and device.

Save recovery ZIPs outside the browser. Clearing browser storage requires an external backup to recover work. Loading a different week shows a warning before removing the previous week's records, photos and local recovery copies.

For an existing installation, open online and choose **⋯ → Apply cached app update** once the new copy is cached. Applying an app update retains the loaded week and saved work.

## Local use

Run `node preview-server.mjs` and open `http://127.0.0.1:8788/`. Localhost supports the offline cache; a phone installation needs an HTTPS address.

Run `node build.mjs` to create an application ZIP. Run `node pages.mjs` to assemble the static site. The publication workflow includes only the declared application files in `public-files.json`.

JSZip and Pako licences are included in `vendor/`.
