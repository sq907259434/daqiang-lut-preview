# Daqiang LUT Preview 2.1 (大强LUT预览2.1)

[中文](README.md) | **English**

A Photoshop panel plugin (UXP) that applies **every 3D LUT in a folder** to your **current photo** and shows them as a thumbnail grid. **Double-click a thumbnail** to create a **Color Lookup adjustment layer** with that LUT already loaded.

Built for retouchers: no more clicking through the Color Lookup LUT list one by one just to see what each looks like.

## Features

- A wall of thumbnails: current photo × all LUTs. A bigger panel shows more thumbnails, with a scrollbar on the right
- **Double-click a thumbnail** → creates a Color Lookup **adjustment layer** (not a pixel layer)
  - Layer name = thumbnail name; layer opacity follows the Intensity slider
  - The Properties panel shows the real loaded 3D LUT, so you can drag the layer onto other photos to keep a whole set consistent
- Supports `.cube` and `.3dl` (including common packs such as VSCO)
- Auto-detects Photoshop's built-in `Presets/3DLUTs` folder; you can also pick any folder manually
- **Frequently used**: your 9 most-used LUTs (by double-click count) are pinned to the top, and the section can be collapsed
- Search, intensity and thumbnail size; thumbnail sharpness scales with the size
- Auto-refreshes when you switch to another photo (can be turned off), plus a manual refresh; scroll position is kept after a refresh

## Installation

1. Download `DaqiangLUTPreview-vX.Y.Z.ccx` from [Releases](../../releases)
2. Double-click the `.ccx` to install (it launches Photoshop's plugin installer)
3. Restart Photoshop and open the panel from **Plugins → 大强LUT预览2.1**

For development you can also load the `plugin/` folder of this repository with Adobe's **UXP Developer Tool**.

> Requires Photoshop 23.3 (2022) or later. Developed and tested on Windows with Photoshop 2026 (27.10). macOS and other versions are not thoroughly tested.

## Usage

| Action | Description |
| --- | --- |
| Open the panel | Open a photo in Photoshop first |
| Double-click a thumbnail | Create a Color Lookup adjustment layer with that LUT loaded |
| "Frequently used" header | Click to collapse/expand; **Alt+click** to clear usage history. Order updates on the next refresh; not shown while searching |
| Search box | Filter LUTs by name |
| Folder icon | Choose a LUT folder; **Alt+click** to go back to Photoshop's built-in folder |
| Auto refresh on switch | On: previews update when you switch to another photo |
| ↻ Refresh | Regenerate previews from the **current** image |
| Intensity | Preview strength, also used as the new layer's opacity |
| Size | Thumbnail size (larger = sharper, fewer per screen) |

**Note**: previews are generated from the document's current composite. If you already have a Color Lookup layer and refresh, the previews apply each LUT on top of the already graded image. To preview "original + LUT", hide existing grading layers first and then refresh.

## How it loads the LUT

A Color Lookup layer needs more than the LUT file: Photoshop also requires an ICC DeviceLink profile to actually render it. This is not documented for UXP, so the plugin:

1. Reads and parses the LUT file (`lut.js`) and resamples it to a 33³ grid
2. Generates an ICC v4 DeviceLink profile (`buildIccDeviceLink`)
3. Uses `batchPlay` to create a `colorLookup` adjustment layer, writing the full path, the raw LUT bytes and the profile
4. Compares the image before and after to verify the LUT took effect; an empty layer that did not take effect is deleted automatically

## Known limitations

- Previews are computed by the plugin in JS (trilinear interpolation, sRGB) and may differ slightly from Photoshop's final rendering
- The first render of a very large LUT folder can take a while
- The `colorLookup` descriptor comes from observing Photoshop's own behavior; future Photoshop updates may require changes

## Repository layout

```
plugin/      plugin source (manifest.json, index.html, index.js, lut.js, styles.css)
dist/        packaged .ccx
```

## Build the package yourself

A `.ccx` is just a zip with the files at the archive root:

```bash
cd plugin
zip -r ../dist/DaqiangLUTPreview.ccx manifest.json index.html index.js lut.js styles.css icons
```

## License

[MIT](LICENSE)
