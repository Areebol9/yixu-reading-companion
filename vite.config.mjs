import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({base:'./',define:{'import.meta.env.VITE_YIXU_DESKTOP':'true'},server:{host:'127.0.0.1',port:5174,strictPort:true},build:{target:'es2022',sourcemap:false,rolldownOptions:{input:{workbench:fileURLToPath(new URL('./workbench.html',import.meta.url))}}}});
