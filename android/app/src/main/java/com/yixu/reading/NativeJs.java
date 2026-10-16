package com.yixu.reading;

import android.content.Context;
import android.os.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Consumer;

/** A single-threaded embedded engine. No WebView, network, or filesystem is exposed to JS. */
final class NativeJs {
    static { System.loadLibrary("yixu_core"); }
    interface Host { void request(JSONObject request); }
    private final HandlerThread thread = new HandlerThread("yixu-native-core");
    private final Handler handler;
    private final Host host;
    private final Consumer<String> failure;
    private final Map<Integer,Runnable> timers = new HashMap<>();
    private final java.security.SecureRandom secureRandom = new java.security.SecureRandom();
    private long pointer;
    private boolean closed;
    NativeJs(Host host,Consumer<String> failure){
        this.host=host;this.failure=failure;thread.start();handler=new Handler(thread.getLooper());
    }
    void start(Context context,String asset){
        handler.post(()->{
            try{
                pointer=createRuntime();if(pointer==0)throw new IOException("无法创建原生JS环境");
                try(InputStream in=context.getAssets().open(asset);ByteArrayOutputStream out=new ByteArrayOutputStream()){
                    byte[] buffer=new byte[8192];int read;while((read=in.read(buffer))!=-1)out.write(buffer,0,read);
                    evaluateNow(new String(out.toByteArray(),StandardCharsets.UTF_8),10000);
                }
            }catch(Exception e){failure.accept(e.toString());}
        });
    }
    private native long createRuntime();
    private native byte[] evaluateNative(long pointer,byte[] source,int limitMs);
    private native byte[] callNative(long pointer,String function,byte[] arguments,int limitMs);
    private native byte[] statisticsNative(long pointer);
    private native void closeNative(long pointer);
    private void evaluateNow(String source,int limitMs){
        if(closed)throw new IllegalStateException("Native JS runtime is closed");
        if(Looper.myLooper()!=handler.getLooper())throw new IllegalStateException("JS accessed off its owning thread");
        byte[] error=evaluateNative(pointer,source.getBytes(StandardCharsets.UTF_8),limitMs);
        if(error!=null)throw new IllegalStateException(new String(error,StandardCharsets.UTF_8));
    }
    void evaluate(String source,int limitMs,Consumer<String> completion){
        if(!handler.post(()->{try{evaluateNow(source,limitMs);completion.accept(null);}catch(Exception e){completion.accept(e.toString());}}))completion.accept("Native JS runtime is closed");
    }
    private void callNow(String function,JSONArray arguments,int limitMs){
        if(closed)throw new IllegalStateException("Native JS runtime is closed");
        if(Looper.myLooper()!=handler.getLooper())throw new IllegalStateException("JS accessed off its owning thread");
        byte[] error=callNative(pointer,function,arguments.toString().getBytes(StandardCharsets.UTF_8),limitMs);
        if(error!=null)throw new IllegalStateException(new String(error,StandardCharsets.UTF_8));
    }
    void call(String function,JSONArray arguments,int limitMs,Consumer<String> completion){
        if(!handler.post(()->{try{callNow(function,arguments,limitMs);completion.accept(null);}catch(Exception e){completion.accept(e.toString());}}))completion.accept("Native JS runtime is closed");
    }
    void resolve(String id,Object value){
        settle(id,value,null);
    }
    void reject(String id,String error){settle(id,null,error);}
    private void settle(String id,Object value,String error){
        handler.post(()->{
            if(closed)return;
            try{JSONObject response=new JSONObject();response.put("value",value==null?JSONObject.NULL:value);
                if(error!=null)response.put("error",error);
                callNow("__yixuResolveValue",new JSONArray().put(id).put(response),10000);
            }catch(Exception e){failure.accept(e.toString());}
        });
    }
    private void hostSend(byte[] utf8){
        String wire=new String(utf8,StandardCharsets.UTF_8);
        // Host actions happen after native evaluation returns, never by re-entering QuickJS.
        handler.post(()->{
            if(closed)return;
            try{
                JSONObject request=new JSONObject(wire);String method=request.optString("method");
                if(method.equals("timer")){
                    int id=request.getInt("id");long delay=Math.max(0,Math.min(Integer.MAX_VALUE,request.optLong("delay")));
                    Runnable action=()->{timers.remove(id);try{evaluateNow("__yixuTimer("+id+");",10000);}catch(Exception e){failure.accept(e.toString());}};
                    timers.put(id,action);handler.postDelayed(action,delay);return;
                }
                if(method.equals("cancelTimer")){Runnable action=timers.remove(request.getInt("id"));if(action!=null)handler.removeCallbacks(action);return;}
                host.request(request);
            }catch(Exception e){failure.accept(e.toString());}
        });
    }
    private byte[] hostSync(byte[] utf8){
        try{
            JSONObject request=new JSONObject(new String(utf8,StandardCharsets.UTF_8));String method=request.getString("method"),result;
            if(method.equals("uuid"))result=JSONObject.quote(UUID.randomUUID().toString());
            else if(method.equals("now"))result=Long.toString(SystemClock.elapsedRealtime());
            else if(method.equals("randomBytes")){
                int length=request.getInt("length");if(length<0||length>65536)throw new IllegalArgumentException("Invalid random byte length");
                byte[] bytes=new byte[length];secureRandom.nextBytes(bytes);JSONArray values=new JSONArray();for(byte value:bytes)values.put(value&255);result=values.toString();
            }
            else throw new IllegalArgumentException("Unknown synchronous capability");
            return result.getBytes(StandardCharsets.UTF_8);
        }catch(Exception e){return "{\"error\":\"Native synchronous capability failed\"}".getBytes(StandardCharsets.UTF_8);}
    }
    JSONObject statistics()throws JSONException{if(Looper.myLooper()!=handler.getLooper())throw new IllegalStateException("Statistics accessed off owning thread");return new JSONObject(new String(statisticsNative(pointer),StandardCharsets.UTF_8));}
    void close(){handler.post(()->{if(closed)return;closed=true;for(Runnable timer:timers.values())handler.removeCallbacks(timer);timers.clear();closeNative(pointer);pointer=0;thread.quitSafely();});}
}
