'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'dtViewer',
  triesKey: 'dtViewer.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'diff', title: 'Compare two device trees', command: 'dtViewer.diff' },
    { id: 'export', title: 'Export and compile', command: 'dtViewer.export' },
    { id: 'addressMap', title: 'Address and pin map', command: 'dtViewer.addressMap' },
  ],
};
