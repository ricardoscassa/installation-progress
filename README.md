# Installation Progress — Production Control

An offline application for recording weekly installation progress by building and room.

**[Open the application](https://ricardoscassa.github.io/installation-progress/)**

Open the app online once and wait for **Offline ready**. Import a prepared weekly ZIP and confirm the person recording the work. Keep using the same browser and address to return to saved work.

Weekly packages can authorise complete work groups within the selected buildings and rooms, including commodities with no planned ECS in that room. Version 1.5 and later read both these packages and earlier weekly ZIPs. Apply the cached app update before loading a newly prepared package; updating retains existing saved work.

## Daily work

- Navigate rooms and open one ECS card at a time. Additional ECS are found through the room's typed search.
- Record gates, percentages, comments and optional photos. Field reporting is limited to 90%.
- In the photo preview, optionally expand **Also apply to other ECS in this room**. Select any number of compatible planned or already-added ECS in the same building and room, then confirm the captured gate and percentage. Each receives an individually stamped photo and a separate draft entry; other answers remain individual. Complete required fields before supervisor review. Leave sharing collapsed for the usual single-ECS camera flow.
- Compare the previous site report with the Mpower claim inside each expanded card. Mpower is a reference and does not determine the reported position or card colour.
- Review the daily draft and record the supervisor's name. Changes after review require another review.
- ECS at 90% remain editable. Correct a mistaken local selection or update its comments and photos; the reporting maximum remains 90%.
- Delete a daily entry from its editor or draft. Undo is available in the collapsed Deleted entries section for the loaded week, including its saved photos. Weekly-plan cards remain available. Restored work requires fresh review.
- Export the daily CSV and recovery data in one ZIP. Photos are prepared in a separate companion ZIP; the ready dialog offers matching Save Data and Save Photos buttons, each downloading its own file. Previous downloads remain available for the active week.

New daily batches use `DL-YYYYMMDD-HHmmss-xxxxxxxx`, with UK local date and time and an eight-character random suffix. Repeat downloads retain the original batch ID. Older saved batches keep their existing IDs.

The app records exports; it does not confirm that exported files were received elsewhere.

Export history keeps each original package unchanged. Use Edit current entry to revise local work and prepare a new reviewed batch. Deleting an entry locally does not cancel a previous download or an upload; corrections to uploaded data are handled manually in its destination.

## Offline storage and recovery

The app caches its required assets and saves records, unfinished editors and photo context on the device. Refreshing or reopening restores saved work. Available storage depends on the browser and device.

Save both daily ZIPs outside the browser when photos exist. The companion includes earlier evidence and interrupted originals needed to restore the whole week. Select both files together when importing daily recovery; older full backups still use one file. New photos use `Building/YYYY-MM-DD/ECS_YYYYMMDD_HHmmss.jpg` with UK capture time and a short suffix only for a naming collision. Existing photos retain their original paths.

Returning from a locked or suspended browser checks storage and reconnects an idle camera input while retaining the open editor, room and work date. Actual camera and download behaviour still depends on the device/browser.

Interrupted photo preparation retains its original image and captured context for retry. Shared-photo selection and notes resume with that original. Every selected copy and extra draft entry saves in one transaction; a failed group save keeps the original available. Shared exports use the same capture time with each ECS's own stamp and filename.

Save recovery ZIPs outside the browser. Clearing browser storage requires an external backup to recover work. Loading a different week shows a warning before removing the previous week's records, photos and local recovery copies.

For an existing installation, open online and choose **⋯ → Apply cached app update** once the new copy is cached. Applying an app update retains the loaded week and saved work.

## Local use

Run `node preview-server.mjs` and open `http://127.0.0.1:8788/`. Localhost supports the offline cache; a phone installation needs an HTTPS address.

Run `node build.mjs` to create an application ZIP. Run `node pages.mjs` to assemble the static site. The publication workflow includes only the declared application files in `public-files.json`.

JSZip and Pako licences are included in `vendor/`.
