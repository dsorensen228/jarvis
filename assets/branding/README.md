# Jarvis portrait

`jarvis-geometric.png` is the selected full-resolution portrait. Device UI, mobile/web,
and Wear OS assets derive from this image; keep the portrait itself unchanged when
resizing or padding for platform icon requirements.

Regenerate the mobile/web variants with `npm --prefix apps/mobile run build:brand-assets`.

`backup/pre-geometric-2026-10-15/` preserves the previous portrait and platform icon
variants byte for byte, using their original repository-relative paths. These are
backup assets only and are not served by the apps.
The backup's `SHA256SUMS` records the original bytes for each variant.

To restore the previous artwork, copy the files in that backup tree to the matching
paths at the repository root, then rebuild and deploy the affected apps. Keep normal
release version numbers increasing when publishing a rollback.
