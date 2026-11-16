# Changelog

## 0.1.0

- First release. Opens .dtb and .dtbo files (Flattened Device Tree, version 16 and 17) as a node tree and as DTS text, with no other program installed.
- A tree view of .dts, .dtsi and Zephyr .overlay files through Open With, and a DeviceTree view in the Explorer that jumps to a node's line.
- Properties decoded as strings, cells or bytes; phandle references resolved and clickable; reg and interrupts decoded with the parent's cell sizes; status shown on every node.
- Labels from __symbols__, overlay targets from __fixups__, header facts and memory reservations.
- Search by node name, label, compatible string or property.
- Zovo Pro tools: Compare two device trees, Export and compile, Address and pin map (1 free try each).
