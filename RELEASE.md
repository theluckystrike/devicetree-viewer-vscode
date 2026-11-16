# DeviceTree Viewer, DTS & DTB 0.1.0 (zovo.zovo-devicetree-viewer)

New listing, staged only. NICHE7 row 1, built by lane NEWB14.

- vsix: out/NEWB14-dist/zovo.zovo-devicetree-viewer/zovo.zovo-devicetree-viewer-0.1.0.vsix
- sha256: 4a61fb4338e48115f9f07b45e8089d374eec1a92eaaed7d35fbdac933c6eb7d9 (407,024 bytes, 39 files)
- Product repo: factory/products/devicetree-viewer-vscode, local commits only (no remote).
- Unit tests: 251 of 251 pass with `npm test` (scripts/test.js). `node --test` in the repo root runs 253 of 253.
- Real-app gate: VS Code 1.142.0 on port 9451 through buildslot. Run r2 on this exact vsix: 70 PASS, 0 FAIL (out/NEWB14-data/devicetree/devicetree-gate-r2.json and .tsv, gate-r2.log, screenshots in out/NEWB14-data/devicetree/shots/devicetree-r2-*.png). Earlier runs: dev1 (64 PASS, 6 FAIL), dev2 (71 PASS, 0 FAIL, took the README screenshot), r1 on this vsix (68 PASS, 2 FAIL, both gate timing faults, see below).

## What it is

- Display name: DeviceTree Viewer, DTS & DTB (28 characters). The phrase "devicetree" comes first, and the description starts with "Devicetree viewer".
- Keywords: devicetree, device tree, dts, dtb, embedded linux. Engines: ^1.75.0. Activation: onUri, onLanguage:dts and onLanguage:devicetree (the language ids of DTS language extensions, if one is installed), plus the custom editors, commands and view. There is no "*" and no onStartupFinished.
- Free core:
  - A read-only custom editor `dtViewer.dtb`, default for *.dtb and *.dtbo. It reads the binary Flattened Device Tree (version 16 and 17) and shows a node tree, a property table and a DTS text tab. Open DTS Text opens a read-only DTS document.
  - A second custom editor `dtViewer.dts` with priority "option" for *.dts, *.dtsi and *.overlay. It opens through Open DeviceTree Viewer (Explorer right-click, the editor title icon, the palette) or Open With. The extension contributes no language and no grammar.
  - The DeviceTree view in the Explorer lists the nodes of the active .dts, .dtsi or .overlay text editor, or of the active viewer. A click jumps to the node's line. The view shows through the context key dtViewer.outlineShown once the extension runs in the window.
  - Values are decoded as strings, cells or bytes. Phandle references resolve to their target and are clickable, with a "Referenced by" list. reg is read with the parent's #address-cells and #size-cells. interrupts are grouped by the interrupt parent's #interrupt-cells. Every node shows its status.
  - Labels come from __symbols__, and overlay fragment targets from __fixups__ and local phandles.
  - Search covers node name, label, compatible and property name or value. Header facts: version, boot CPU, memory reservations, block sizes, node, property and label counts. For DTS files: the includes and the &label blocks from other files.
  - A .dtb without the magic, a cut or empty file, and a DTS syntax error each get a plain note. The DTS note names the line and keeps the nodes read before it.
- The DTB reader and writer, the DTS parser, the compiler, the diff and the address map were written for this extension from the Devicetree Specification 0.4. No third-party code ships in the package.
- Zovo Pro tools (1 free try each, module 2026-11-15.conv2, listing tag "devicetree", tries key dtViewer.proTrial, TRIAL_USES = 1 in src/pro.js, proinfo factory/sprint/license/proinfo/devicetree.json without triesMax):
  - Compare two device trees (row tool 2): DTB with DTB, DTS with DTB, A with B. Nodes are matched by path and properties by name. References compare by target node path, so renumbered phandles are not a change. Report as Markdown or HTML.
  - Export and compile (row tool 3): DTS, JSON or YAML from any tree. A DTS compiles to .dtb with the built-in FDT writer: phandles are kept or assigned, __symbols__ is written for labels, and expressions and #defines of the same file are evaluated. The compiled file opens in the viewer.
  - Address and pin map (row tool 4): reg ranges as CPU addresses through every parent's ranges, plus bus addresses, interrupts, GPIOs and pinctrl in one sortable, filterable table. Overlapping ranges, bus addresses used twice and GPIO pins used twice are flagged for enabled nodes. CSV export.
- Row tool 1 (merged view of #include and overlay chains) was not built.
- Nothing pops up on open. No network calls: webview CSP default-src 'none' with nonce scripts, no fetch or socket code. The Pro panel shows only after a click on a Pro tool with no tries left.

## Samples used

- Shipped: samples/zovo-demo-board.dts (written for this extension, MIT) and samples/zovo-demo-board.dtb (that file compiled by the extension; unit test checks byte equality).
- Unit-test fixtures (not in the vsix): two Zephyr overlays (Apache-2.0, from zephyrproject-rtos/zephyr samples/basic/blinky_pwm/boards/nrf52840dk_nrf52840.overlay and samples/drivers/led/led_strip/boards/esp32c3_devkitm.overlay), plus a broken DTS, a text file named .dtb, a /plugin/ overlay and an expressions file written for the tests. Core tests also read the real files below when newb14-work/devicetree/dl exists, and skip them otherwise.
- Real-app gate (not shipped, downloaded once into newb14-work/devicetree/dl, each file in its own folder, never executed):
  - Raspberry Pi firmware DTBs and DTBOs from https://raw.githubusercontent.com/raspberrypi/firmware/master/boot/: bcm2711-rpi-4-b.dtb, bcm2711-rpi-cm4.dtb, bcm2710-rpi-3-b.dtb, overlays/i2c-rtc.dtbo, overlays/disable-bt.dtbo. These are compiled from the Raspberry Pi Linux device tree sources (GPL-2.0).
  - Linux kernel DTS from https://raw.githubusercontent.com/torvalds/linux/master/arch/arm/boot/dts/: broadcom/bcm2711-rpi-4-b.dts (GPL-2.0), ti/omap/am335x-boneblack.dts and ti/omap/am335x-bone-common.dtsi (BeagleBone Black, GPL-2.0-only).
  - Zephyr from https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/: boards/nordic/nrf52840dk/nrf52840dk_nrf52840.dts and the two sample overlays above (Apache-2.0).
  - In total 204 KB on disk.

## Gate coverage (r2)

- Start and free core:
  - Nothing pops up on start.
  - Our DTB opens by default. Node and property counts match the gate's own FDT reader. The header facts are checked.
  - The toolbar Pro row shows 3 tools with "1 free try".
  - Search by compatible finds 1 node, and Enter goes to it. The properties, the reg decode and the interrupt grouping match the file.
  - A clicked reference goes to its target, and Referenced by lists the users. The DTS text tab marks the node line.
  - Tree rows are indented by depth (set without inline styles). Open DTS Text opens a /dts-v1/ tab.
- Real files:
  - 3 real RPi DTBs: counts and model match the gate reader. On the RPi 4, the GPIO controller is found by compatible, with its reg as in the file and the label count from __symbols__.
  - 2 real DTBOs: fragment count, and targets named from __fixups__.
  - 7 DTS, DTSI and overlay files open as text by default. Open DeviceTree Viewer shows the tree, and the &label blocks and includes match what the gate finds in the text.
  - The DeviceTree view in the Explorer lists the nodes of the open nRF52840 DK .dts. A click on "chosen" moves the cursor to line 18.
- Broken files: the text-as-.dtb, cut DTB, empty DTBO and DTS syntax-error notes, and no error toast.
- Explorer right-click on BOARD.DTB shows Open DeviceTree Viewer and the 3 Zovo Pro entries.
- Pro tools:
  - Compare, from the toolbar row: RPi 4 against CM4. The 5 nodes only in A and 6 only in B equal the gate's own path sets. Markdown is saved. The 2nd use from the palette on another file opens the Pro panel.
  - Export, from the toolbar row of the DTS viewer, compiles the DTS text of the real RPi 4 DTB. The new .dtb holds the same nodes and property bytes as the original (gate reader) and opens in the viewer beside. The 2nd use from an Explorer right-click opens the Pro panel.
  - Address map, from the toolbar row, on the RPi 4: all 90 /soc reg ranges sit at the CPU address the gate translates through /soc ranges. The gpio and gpiomem overlap is flagged. The CSV line count equals the table. The 2nd use from the palette on another file opens the Pro panel.
  - The info tab (palette Get Zovo Pro) shows "no free tries left" for all 3 tools. No URL was opened.
- End of run: no error toast, no notification from the extension, no webview network request, no extension host socket, no webview console or CSP error.
- After a VS Code restart with the same profile, the row shows "0 tries left" ×3 and Compare opens the Pro panel. The window was closed and the profile deleted.

## Defects found and fixed in the gate runs

- Product (dev1): tree indentation was set with an inline style attribute, which the webview CSP blocks (CSP log line, flat tree). It is now set through the style object.
- Product (dev1): a DTS syntax error dropped the nodes read before it (only "/" showed). Nodes are now kept as they are read.
- Product (dev1): the DeviceTree view's when clause (resourceExtname) did not show the view for a .dts text editor. The view now uses a context key that the extension sets, plus onLanguage activation for DTS language ids.
- Product (dev1): the note for a text file named .dtb had no Open as Text button, though the README promised one. It has one now.
- Product (unit test after dev2): the package description named the reference compiler, and source comments named it too. Both are reworded, and a test now scans the shipped text and sources for tool names.
- Product (dev1 screenshots): long string values broke mid-word, and the map table wrapped hex addresses. Wrapping is fixed.
- Gate (r1): the export status check ran after the 8-second status message had gone, and the tab check read only the active group. Both are reordered or widened; r2 passes on the same vsix.

## Known limits

- One file at a time: the C preprocessor is not run. #include lines are listed but not read, and macro names from headers stay as text. Compiling needs a complete tree in one file, and the export names the line that blocks it. The merged view of include and overlay chains (row tool 1) is not built.
- DTB values have no type information. Strings, cells and bytes are told apart by content and by known property names, and phandle cells are found by property name (clocks, gpios, interrupts-extended, pinctrl-N and others) and the target's #...-cells. An unusual property can show as plain numbers.
- Address translation follows `ranges` with plain numeric cells. PCI-style 3-cell addresses are not decoded specially.
- The DeviceTree Explorer view appears once the extension runs in the window, that is after a viewer opens, after one of its commands, or when a DTS language extension is installed.
- The gate drove Save dialogs through VS Code's simple file dialog, not the native macOS dialog. The Explorer sidebar is visible in the README screenshot.
