/* Viewport crops of the supplied reference artwork, exactly as the prototype used them. */
export function Art({ file, box, className, width = 1672, height = 941 }: { file: string; box: string; className?: string; width?: number; height?: number }) {
  return (
    <svg className={className} viewBox={box} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <image href={`/assets/references/${file}.png`} x="0" y="0" width={width} height={height} />
    </svg>
  );
}
