# bb-plugin-ios-composer-touch

Ports the composer half of [get-bb/bb#1673](https://github.com/get-bb/bb/pull/1673)
to a bb plugin so it runs on a stock bb install.

- Send works on the first tap on iOS. A capture-phase `pointerdown` listener
  cancels the focus transfer for the composer submit button, so the keyboard
  stays open and the click sends.
- 44px hit areas (visual size unchanged) on compact coarse-pointer viewports for the composer
  submit/stop/voice slot and the inline-editor cancel button.

Remove this plugin once the upstream fix ships.
