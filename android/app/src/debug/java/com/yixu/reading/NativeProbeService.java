package com.yixu.reading;

import android.app.*;
import android.content.Intent;
import android.os.*;
import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.HashMap;

/** Debug-only fixed scenarios. Real model calls require a private, expiring authorization. */
public final class NativeProbeService extends Service {
    private NativeJs core;
    private NativeFileStore store;
    private HostBridge transport;
    private boolean realModel;
    private boolean companion,companionResume,companionCorrection;
    private int nativeMockRequests,nativeMockCancels;
    private final HashMap<String,JSONObject> mockPending=new HashMap<>();
    private int modelRequests,cancelRequests;
    private int largeCharacters;
    private String probeId;
    private long started;
    private final AtomicBoolean finished=new AtomicBoolean();
    private final Handler watchdog=new Handler(Looper.getMainLooper());
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(core!=null)return START_NOT_STICKY;
        probeId=intent==null?null:intent.getStringExtra("probeId");
        if(probeId==null||!probeId.matches("[A-Za-z0-9_-]{1,80}")){stopSelf();return START_NOT_STICKY;}
        started=SystemClock.elapsedRealtime();
        try{
            realModel=intent.getBooleanExtra("realModel",false);
            largeCharacters=intent.getIntExtra("largeCharacters",0);
            boolean harness=intent.getBooleanExtra("harness",false);
            companion=intent.getBooleanExtra("companion",false);companionResume=intent.getBooleanExtra("companionResume",false);
            boolean readingEmpty=intent.getBooleanExtra("readingEmpty",false);
            companionCorrection=intent.getBooleanExtra("companionCorrection",false);
            if(companionCorrection&&(!companion||companionResume||readingEmpty))throw new IOException("更正接续探测仅允许独立固定工程模式");
            if(readingEmpty&&(!companion||companionResume||realModel||harness||largeCharacters!=0))throw new IOException("缺正文续交探测只允许独立固定工程响应");
            if(companion&&(harness||realModel||largeCharacters!=0))throw new IOException("持续伴读探测只使用隔离工程资料");
            if(companionResume&&!companion)throw new IOException("接续模式需要持续伴读探测");
            if(harness&&(realModel||largeCharacters!=0))throw new IOException("Harness探测仅使用固定工程材料");
            if(largeCharacters!=0&&largeCharacters!=3000000)throw new IOException("工程规模参数无效");
            if(realModel){
                AtomicFile authorization=new AtomicFile(new File(getFilesDir(),"native-probe-authorization.json"));
                JSONObject allowed=new JSONObject(new String(authorization.readFully(),StandardCharsets.UTF_8));
                if(!probeId.equals(allowed.optString("probeId"))||!allowed.optString("nonce").equals(intent.getStringExtra("authorization"))||allowed.optLong("expiresAt")<System.currentTimeMillis())throw new IOException("真实模型探测没有有效的本机授权");
                write("native-probe-authorization.json","{}");
            }
            store=new NativeFileStore(new File(getFilesDir(),companion?"native-companion-probe-"+probeId:"native-probe-store"));
            JSONObject running=new JSONObject();running.put("probeId",probeId);running.put("status","running");write("native-probe-report.json",running.toString());
            watchdog.postDelayed(()->fail("Native probe watchdog expired"),realModel?150000:30000);
            if(realModel)transport=new HostBridge(getApplicationContext(),(id,data,error)->{
                if(core==null||finished.get())return;
                if(error!=null){core.reject(id,error);return;}
                try{core.resolve(id,data instanceof String?new JSONTokener((String)data).nextValue():data);}catch(Exception e){core.reject(id,"原生响应格式无效");}
            },(name,payload)->{});
            core=new NativeJs(this::request,this::fail);
            core.start(getApplicationContext(),readingEmpty?"core-reading-empty-probe.js":companion?"core-companion-probe.js":harness?"core-harness-probe.js":"core-probe.js");
        }catch(Throwable error){fail(error.toString());}
        return START_NOT_STICKY;
    }
    private void request(JSONObject request){
        try{
            String method=request.getString("method"),id=request.optString("id");
            if(method.equals("probeConfig")){JSONObject cfg=new JSONObject();cfg.put("realModel",realModel);cfg.put("largeCharacters",largeCharacters);cfg.put("companionResume",companionResume);cfg.put("companionCorrection",companionCorrection);core.resolve(id,cfg);return;}
            if(companion&&method.equals("model")){
                JSONObject payload=request.getJSONObject("payload").getJSONObject("companionProbe");nativeMockRequests++;
                String hold=payload.optString("hold");
                if(hold.isEmpty())core.resolve(id,payload.getJSONObject("response"));
                else {if(!hold.matches("background|first|second")||mockPending.containsKey(hold))throw new IOException("重复工程阶段");payload.put("id",id);mockPending.put(hold,payload);}
                return;
            }
            if(companion&&method.equals("companionMockStatus")){JSONObject result=new JSONObject();for(String hold:mockPending.keySet())result.put(hold,true);result.put("requests",nativeMockRequests);result.put("cancels",nativeMockCancels);core.resolve(id,result);return;}
            if(companion&&method.equals("releaseCompanionMock")){JSONObject held=mockPending.remove(request.getJSONObject("payload").getString("hold"));if(held==null)throw new IOException("工程阶段尚未派发");core.resolve(held.getString("id"),held.getJSONObject("response"));core.resolve(id,JSONObject.NULL);return;}
            if(method.equals("probeHeap")){core.resolve(id,core.statistics());return;}
            if(method.equals("model")){
                if(!realModel)throw new IOException("固定模型探测不允许联网调用");
                JSONObject payload=request.getJSONObject("payload");
                if(!payload.optString("serviceId").equals("wechat")||!payload.optString("baseUrl").equals("https://chatapi.weixin.qq.com/openai/v1"))throw new IOException("此探测仅允许已授权腾讯渠道");
                modelRequests++;transport.request(id,method,payload.toString());return;
            }
            if(method.equals("cancel")){if(companion){String target=request.getJSONObject("payload").optString("id");nativeMockCancels++;mockPending.values().removeIf(value->target.equals(value.optString("id")));}if(transport!=null){cancelRequests++;transport.request("cancel-"+request.getJSONObject("payload").optString("id"),"cancel",request.getJSONObject("payload").toString());}return;}
            if(method.equals("sha256")){
                JSONArray bytes=request.getJSONObject("payload").getJSONArray("bytes");byte[] input=new byte[bytes.length()];
                for(int i=0;i<input.length;i++)input[i]=(byte)bytes.getInt(i);
                byte[] hash=MessageDigest.getInstance("SHA-256").digest(input);JSONArray result=new JSONArray();for(byte value:hash)result.put(value&255);core.resolve(id,result);return;
            }
            if(method.equals("hashText")){core.resolve(id,Utf8Text.hash(request.getJSONObject("payload").getString("text")));return;}
            if(method.equals("putBookText")){store.putBookText(request.getJSONObject("payload"));core.resolve(id,JSONObject.NULL);return;}
            if(method.equals("saveState")){store.save(request.getJSONObject("payload"));core.resolve(id,JSONObject.NULL);return;}
            if(method.equals("applyStateChanges")){store.applyStateChanges(request.getJSONObject("payload"));core.resolve(id,JSONObject.NULL);return;}
            if(method.equals("loadState")){core.resolve(id,store.load());return;}
            if(method.equals("readBookText")){core.resolve(id,store.readBookText(request.getJSONObject("payload").getString("version")));return;}
            if(method.equals("readBookRanges")){JSONObject p=request.getJSONObject("payload");core.resolve(id,store.readBookRanges(p.getString("version"),p.getJSONArray("ranges")));return;}
            if(method.equals("putMemoryBody")){store.putMemoryBody(request.getJSONObject("payload"));core.resolve(id,JSONObject.NULL);return;}
            if(method.equals("readMemoryBodies")){core.resolve(id,store.readMemoryBodies(request.getJSONObject("payload").getJSONArray("refs")));return;}
            if(method.equals("putTaskMaterial")){store.putTaskMaterial(request.getJSONObject("payload"));core.resolve(id,JSONObject.NULL);return;}
            if(method.equals("readTaskMaterials")){core.resolve(id,store.readTaskMaterials(request.getJSONObject("payload").getJSONArray("refs")));return;}
            if(method.equals("report")){
                JSONObject result=request.getJSONObject("payload");result.put("heap",core.statistics());result.put("store",store.statistics());result.put("nativeModelRequests",modelRequests);result.put("nativeCancelRequests",cancelRequests);result.put("nativeMockRequests",nativeMockRequests);result.put("nativeMockCancels",nativeMockCancels);
                if(!result.optBoolean("ok")){finish(result);return;}
                core.evaluate("while(true){}",200,error->{
                    try{
                        result.put("executionTimeout",error!=null&&error.contains("interrupted"));
                        core.evaluate("globalThis.__afterTimeout=1;",1000,recoveryError->{
                            try{result.put("usableAfterTimeout",recoveryError==null);result.put("ok",result.optBoolean("executionTimeout")&&recoveryError==null);finish(result);}catch(Exception e){fail(e.toString());}
                        });
                    }catch(Exception e){fail(e.toString());}
                });return;
            }
            fail("Unknown probe host capability: "+method);
        }catch(Exception e){String id=request.optString("id");if(core!=null&&!id.isEmpty())core.reject(id,e.getMessage()==null?e.toString():e.getMessage());else fail(e.toString());}
    }
    private void write(String name,String content)throws IOException{
        AtomicFile file=new AtomicFile(new File(getFilesDir(),name));FileOutputStream stream=null;
        try{stream=file.startWrite();stream.write(content.getBytes(StandardCharsets.UTF_8));file.finishWrite(stream);}catch(IOException e){if(stream!=null)file.failWrite(stream);throw e;}
    }
    private void fail(String message){try{JSONObject result=new JSONObject();result.put("ok",false);result.put("error",message);finish(result);}catch(Exception ignored){stopSelf();}}
    private String processName(){
        if(Build.VERSION.SDK_INT>=28)return Application.getProcessName();
        ActivityManager manager=(ActivityManager)getSystemService(ACTIVITY_SERVICE);
        java.util.List<ActivityManager.RunningAppProcessInfo> processes=manager.getRunningAppProcesses();
        if(processes!=null)for(ActivityManager.RunningAppProcessInfo info:processes)if(info.pid==android.os.Process.myPid())return info.processName;
        return "unavailable";
    }
    private void finish(JSONObject result){
        if(!finished.compareAndSet(false,true))return;
        watchdog.removeCallbacksAndMessages(null);
        try{result.put("probeId",probeId);result.put("status","complete");result.put("runtime","QuickJS-NG 0.17.0");result.put("process",processName());result.put("elapsedMs",SystemClock.elapsedRealtime()-started);write("native-probe-report.json",result.toString());}catch(Exception ignored){}
        stopSelf();
    }
    @Override public void onDestroy(){watchdog.removeCallbacksAndMessages(null);if(transport!=null)transport.close();if(core!=null)core.close();super.onDestroy();if(companion&&"com.yixu.reading:native_probe".equals(processName()))new Handler(Looper.getMainLooper()).postDelayed(()->android.os.Process.killProcess(android.os.Process.myPid()),300);}
    @Override public IBinder onBind(Intent intent){return null;}
}
