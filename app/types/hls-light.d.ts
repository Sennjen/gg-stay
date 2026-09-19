// hls.js publishes a "./light" export condition (a smaller build without subtitle/audio-track
// handling or EME support — see app/components/HeroVideo.vue), but its package.json only maps a
// "types" file for the package root, not for that subpath. The light build's default export has
// the same public API surface as the full one, so this just points TypeScript at it.
declare module 'hls.js/light' {
  export { default } from 'hls.js'
}
