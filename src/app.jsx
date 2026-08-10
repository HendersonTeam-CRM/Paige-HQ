21:51:46.213 Running build in Washington, D.C., USA (East) – iad1
21:51:46.214 Build machine configuration: 2 cores, 8 GB
21:51:46.344 Cloning github.com/HendersonTeam-CRM/Paige-HQ (Branch: main, Commit: 617a3bb)
21:51:46.982 Cloning completed: 638.000ms
21:51:47.125 Restored build cache from previous deployment (Euc2zGgGkxszg9ec1T2xXaCdvZer)
21:51:47.317 Running "vercel build"
21:51:47.335 Vercel CLI 58.1.0
21:51:48.181 Installing dependencies...
21:51:50.610 
21:51:50.611 up to date in 2s
21:51:50.611 
21:51:50.611 9 packages are looking for funding
21:51:50.611   run `npm fund` for details
21:51:50.650 Running "npm run build"
21:51:50.757 
21:51:50.757 > paige-hq@1.0.0 build
21:51:50.757 > vite build
21:51:50.757 
21:51:50.985 vite v5.4.21 building for production...
21:51:51.047 transforming...
21:51:51.163 ✓ 5 modules transformed.
21:51:51.163 x Build failed in 148ms
21:51:51.163 error during build:
21:51:51.164 [vite:esbuild] Transform failed with 1 error:
21:51:51.164 /vercel/path0/src/app.jsx:3342:6: ERROR: Unexpected ")"
21:51:51.164 file: /vercel/path0/src/app.jsx:3342:6
21:51:51.164 
21:51:51.164 Unexpected ")"
21:51:51.164 3340|        {mode === "client" && (
21:51:51.164 3341|  
21:51:51.164 3342|        )}
21:51:51.164    |        ^
21:51:51.164 3343|      </div>
21:51:51.164 3344|    );
21:51:51.164 
21:51:51.164     at failureErrorWithLog (/vercel/path0/node_modules/esbuild/lib/main.js:1472:15)
21:51:51.164     at /vercel/path0/node_modules/esbuild/lib/main.js:755:50
21:51:51.164     at responseCallbacks.<computed> (/vercel/path0/node_modules/esbuild/lib/main.js:622:9)
21:51:51.164     at handleIncomingPacket (/vercel/path0/node_modules/esbuild/lib/main.js:677:12)
21:51:51.164     at Socket.readFromStdout (/vercel/path0/node_modules/esbuild/lib/main.js:600:7)
21:51:51.164     at Socket.emit (node:events:509:28)
21:51:51.164     at addChunk (node:internal/streams/readable:563:12)
21:51:51.164     at readableAddChunkPushByteMode (node:internal/streams/readable:514:3)
21:51:51.164     at Readable.push (node:internal/streams/readable:394:5)
21:51:51.164     at Pipe.onStreamRead (node:internal/stream_base_commons:189:23)
21:51:51.186 Error: Command "npm run build" exited with 1
