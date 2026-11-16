# Third-party notices

The extension ships no third-party code. The device tree reader and writer, the DTS parser, the compiler, the comparison and the address map are written for this extension from the public Devicetree Specification (release 0.4, https://www.devicetree.org/specifications/). No code from other device tree tools is used.

## Sample files

samples/zovo-demo-board.dts describes a made-up board and was written for this extension (MIT, like the extension). samples/zovo-demo-board.dtb is that file compiled by the extension's own compiler.

## Test files (in the source repository, not in the extension package)

test/fixtures/zephyr-blinky-pwm-nrf52840dk.overlay and test/fixtures/zephyr-led-strip-esp32c3.overlay are board overlays from the Zephyr Project samples (samples/basic/blinky_pwm and samples/drivers/led/led_strip, https://github.com/zephyrproject-rtos/zephyr), Apache-2.0. The other fixtures were written for these tests.
