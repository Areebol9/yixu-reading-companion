package com.yixu.reading;

import android.content.Context;
import android.webkit.JavascriptInterface;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Application-scoped authority. The WebView is a reconnectable renderer. */
final class NativeCore {
    private static volatile NativeCore instance;
    private final NativeJs js;
    private final NativeFileStore store;
    private final HostBridge transport;
    private final Set<String> nativeRequests=ConcurrentHashMap.newKeySet();
    private final List<String> connecting=new ArrayList<>();
    private JSONObject ready;
    private volatile String failure;
    static synchronized NativeCore get(Context context){if(instance==null)instance=new NativeCore(context.getApplicationContext());return instance;}
    static NativeCore peek(){return instance;}
    synchronized JSONObject debugIdentity()throws JSONException{
        if(!BuildConfig.DEBUG)throw new IllegalStateException();
        JSONObject out=new JSONObject();out.put("runtime","QuickJS-NG");out.put("failed",failure!=null);
        JSONObject frame=ready==null?null:ready.optJSONObject("frame");
        if(frame!=null){out.put("epoch",frame.optString("epoch"));JSONObject snapshot=frame.getJSONObject("snapshot");out.put("revision",snapshot.optLong("revision"));out.put("session",snapshot.optJSONObject("session"));out.put("busy",snapshot.optBoolean("busy"));}
        return out;
    }
    NativeCore(Context context){
        try{store=new NativeFileStore(new File(context.getFilesDir(),"reading-core"));}catch(Exception e){throw new IllegalStateException(e);}
        transport=new HostBridge(context,this::hostResponse,this::event,true);
        js=new NativeJs(this::request,this::fail);
        js.start(context,"reading-core.js");
    }
    private synchronized void fail(String reason){
        if(failure!=null)return;
        failure="共读核心暂不可用："+reason;
        transport.close();if(js!=null)js.close();
        MainActivity.ui.post(()->{if(MainActivity.current!=null){MainActivity.current.cancelCapture();MainActivity.current.cancelVoice();}});
        for(String id:connecting)MainActivity.webRespond(id,"{}",failure);connecting.clear();
        MainActivity.webEvent("applicationFailure",MainActivity.object("message",failure));
    }
    private void evaluate(String code){js.evaluate(code,15000,error->{if(error!=null)fail(error);});}
    private void call(String function,JSONArray arguments){js.call(function,arguments,15000,error->{if(error!=null)fail(error);});}
    private synchronized void connect(String id){
        if(failure!=null){MainActivity.webRespond(id,"{}",failure);return;}
        if(ready!=null)MainActivity.webRespond(id,ready,null);else connecting.add(id);
    }
    void event(String name,JSONObject value){if(js!=null&&failure==null)evaluate("globalThis.__applicationEvent?.("+JSONObject.quote(name)+","+value+");");}
    private void hostResponse(String id,Object data,String error){
        if(!completeHost(id,data,error))MainActivity.webRespond(id,data,error);
    }
    boolean completeHost(String id,Object data,String error){
        if(!nativeRequests.remove(id))return false;
        if(error!=null){js.reject(id,error);return true;}
        try{js.resolve(id,data instanceof String?new JSONTokener((String)data).nextValue():data);}catch(Exception e){js.reject(id,"设备返回格式无效");}return true;
    }
    private void request(JSONObject request){
        String id=request.optString("id");
        try{
            String method=request.getString("method");JSONObject payload=request.optJSONObject("payload");
            if(method.equals("applicationReady")){
                synchronized(this){ready=payload;for(String pending:connecting)MainActivity.webRespond(pending,ready,null);connecting.clear();}return;
            }
            if(method.equals("applicationFrame")){
                synchronized(this){if(ready!=null)ready.put("frame",payload);}
                MainActivity.webEvent(method,payload);return;
            }
            if(method.equals("applicationResult")){MainActivity.webEvent(method,payload);return;}
            if(method.equals("applicationInitialized")){MainActivity.webRespond(payload.getString("id"),ready,payload.has("error")?payload.getString("error"):null);return;}
            if(method.equals("applicationFailure")){fail(payload.optString("message"));return;}
            if(method.equals("loadState")){js.resolve(id,store.load());return;}
            if(method.equals("readBookText")){js.resolve(id,store.readBookText(payload.getString("version")));return;}
            if(method.equals("readBookRanges")){js.resolve(id,store.readBookRanges(payload.getString("version"),payload.getJSONArray("ranges")));return;}
            if(method.equals("saveState")){store.save(payload);js.resolve(id,JSONObject.NULL);return;}
            if(method.equals("applyStateChanges")){store.applyStateChanges(payload);js.resolve(id,JSONObject.NULL);return;}
            if(method.equals("putBookText")){store.putBookText(payload);js.resolve(id,JSONObject.NULL);return;}
            if(method.equals("putMemoryBody")){store.putMemoryBody(payload);js.resolve(id,JSONObject.NULL);return;}
            if(method.equals("readMemoryBodies")){js.resolve(id,store.readMemoryBodies(payload.getJSONArray("refs")));return;}
            if(method.equals("putTaskMaterial")){store.putTaskMaterial(payload);js.resolve(id,JSONObject.NULL);return;}
            if(method.equals("readTaskMaterials")){js.resolve(id,store.readTaskMaterials(payload.getJSONArray("refs")));return;}
            if(method.equals("readMemoryIndex")){js.resolve(id,store.readMemoryIndex());return;}
            if(method.equals("writeMemoryIndex")){store.writeMemoryIndex(payload.get("index"));js.resolve(id,JSONObject.NULL);return;}
            if(method.equals("hashText")){js.resolve(id,Utf8Text.hash(payload.getString("text")));return;}
            if(method.equals("sha256")){
                JSONArray bytes=payload.getJSONArray("bytes");byte[] input=new byte[bytes.length()];for(int i=0;i<input.length;i++)input[i]=(byte)bytes.getInt(i);
                JSONArray hash=new JSONArray();for(byte b:MessageDigest.getInstance("SHA-256").digest(input))hash.put(b&255);js.resolve(id,hash);return;
            }
            if(method.equals("cancel")){nativeRequests.remove(payload.optString("id"));transport.request("cancel-"+UUID.randomUUID(),method,payload.toString());return;}
            nativeRequests.add(id);transport.request(id,method,payload==null?"{}":payload.toString());
        }catch(Exception e){js.reject(id,String.valueOf(e.getMessage()));}
    }
    private void clientRequest(String id,String method,String wire){
        try{
            if(method.equals("applicationConnect")){connect(id);return;}
            JSONObject payload=new JSONObject(wire);
            if(method.equals("applicationInitialize")){
                synchronized(this){if(ready==null||!ready.optBoolean("needsMigration")||failure!=null)throw new IOException("资料已初始化或核心未就绪");}
                call("__applicationInitialize",new JSONArray().put(id).put(payload.opt("state")));return;
            }
            if(method.equals("applicationCommand")){
                synchronized(this){if(ready==null||ready.optBoolean("needsMigration")||failure!=null)throw new IOException("运行核心未就绪");}
                if(!id.equals(payload.optString("id")))throw new IOException("操作标识不一致");
                call("__applicationCommand",new JSONArray().put(payload));return;
            }
            if(method.equals("applicationAck")){evaluate("__applicationAck("+JSONObject.quote(payload.getString("epoch"))+","+payload.getLong("sequence")+");");MainActivity.webRespond(id,"{}",null);return;}
            // The renderer may open OS UI and inspect explicit search connectivity.
            // It cannot bypass the core to call a model, alter storage or enable services.
            if(!Arrays.asList("readingSources","permissions","voiceCheck","exportFile","openWebSource","search","readPage","cancel").contains(method))throw new IOException("此操作由共读核心处理");
            transport.request(id,method,wire);
        }catch(Exception e){
            if(method.equals("applicationCommand")){
                try{JSONObject out=new JSONObject();out.put("id",id);out.put("epoch",new JSONObject(wire).optString("epoch"));out.put("error",e.getMessage());MainActivity.webEvent("applicationResult",out);}catch(Exception ignored){}
            }else MainActivity.webRespond(id,"{}",e.getMessage());
        }
    }
    static final class ClientBridge {
        private final NativeCore core;
        ClientBridge(Context context){core=NativeCore.get(context);}
        @JavascriptInterface public void request(String id,String method,String payload){core.clientRequest(id,method,payload);}
    }
}
