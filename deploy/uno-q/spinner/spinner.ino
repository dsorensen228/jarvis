#include <Arduino_LED_Matrix.h>
#include "spinner_frames.h"

Arduino_LED_Matrix matrix;

void setup() {
  matrix.begin();
  matrix.setGrayscaleBits(8);
}

void loop() {
  for (uint8_t frame = 0; frame < 8; ++frame) {
    matrix.draw(const_cast<uint8_t *>(kSpinnerFrames[frame]));
    delay(128);
  }
}
