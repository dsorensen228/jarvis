import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/** Outline glyph inspired by brand artwork: hair, monocle, mustache, bow tie — matches Ionicon outline tabs at ~18px. */
export function JarvisTabIcon({
  size = 18,
  color,
}: {
  size?: number;
  color: string;
}) {
  const s = size;
  const vb = 24;
  return (
    <Svg width={s} height={s} viewBox={`0 0 ${vb} ${vb}`} fill="none">
      {/* Hair / head contour */}
      <Path
        d="M7 10c0-3 2.5-5.5 5.5-5.5S18 7 18 10v1.5"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
      />
      {/* Monocle */}
      <Circle cx={11} cy={11} r={2.25} stroke={color} strokeWidth={1.75} />
      <Path d="M13.2 11h3.3c.8 0 1.5.6 1.7 1.4l.5 2" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      {/* Eye */}
      <Circle cx={15.5} cy={11} r={0.9} fill={color} />
      {/* Handlebar mustache */}
      <Path
        d="M8 15c1.2-1.2 3-1 4 .3 1-.8 2.8-1 4-.3"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
      />
      {/* Bow tie */}
      <Path
        d="M10.5 17.5l1.5 1 1.5-1M12 18.5v1.2"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}
