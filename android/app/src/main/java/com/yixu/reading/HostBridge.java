package com.yixu.reading;

import android.content.*;
import android.webkit.JavascriptInterface;
import android.security.keystore.*;
import android.util.Base64;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

public class HostBridge {
    interface ResponseSink { void respond(String id,Object data,String error); }
    interface EventSink { void event(String name,JSONObject payload); }
    private final Context context;
    private final ResponseSink responses;
    private final EventSink events;
    private final boolean allowUi;
    private final ConnectivityManager networkManager;
    private final ConnectivityManager.NetworkCallback networkCallback;
    private final ExecutorService executor=Executors.newFixedThreadPool(2);
    private final Map<String,HttpURLConnection> calls=new ConcurrentHashMap<>();
    private final Set<String> cancelled=ConcurrentHashMap.newKeySet();
    private final Set<String> jobs=ConcurrentHashMap.newKeySet();
    private volatile boolean closed;
    private volatile boolean networkOnline=true;
    HostBridge(Context context){this(context,MainActivity::respond,MainActivity::event,true);}
    HostBridge(Context context,ResponseSink responses,EventSink events){this(context,responses,events,false);}
    HostBridge(Context context,ResponseSink responses,EventSink events,boolean allowUi){
        this.context=context;this.responses=responses;this.events=events;this.allowUi=allowUi;
        networkManager=(ConnectivityManager)context.getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkCapabilities initial=networkManager.getNetworkCapabilities(networkManager.getActiveNetwork());
        networkOnline=initial!=null&&initial.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        networkCallback=new ConnectivityManager.NetworkCallback(){
            @Override public void onCapabilitiesChanged(Network network,NetworkCapabilities caps){updateNetwork(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)&&caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));}
            @Override public void onLost(Network network){updateNetwork(false);}
        };
        networkManager.registerDefaultNetworkCallback(networkCallback);
    }
    private void updateNetwork(boolean online){if(closed||online==networkOnline)return;networkOnline=online;events.event("network",object("online",online));}
    private void respond(String id,Object data,String error){if(!closed&&!cancelled.contains(id))responses.respond(id,data,error);}
    private static JSONObject object(Object... pairs){JSONObject value=new JSONObject();try{for(int i=0;i<pairs.length;i+=2)value.put((String)pairs[i],pairs[i+1]);}catch(JSONException e){throw new IllegalArgumentException(e);}return value;}
    void close(){
        closed=true;cancelled.addAll(jobs);for(HttpURLConnection call:calls.values())call.disconnect();calls.clear();
        executor.shutdownNow();
        try{networkManager.unregisterNetworkCallback(networkCallback);}catch(RuntimeException ignored){}
    }
    private SharedPreferences prefs(){return context.getSharedPreferences("services",Context.MODE_PRIVATE);}
    private synchronized String crypt(String value,boolean encrypt)throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);String alias="yixu-model-keys";
        if(!store.containsAlias(alias)){KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");gen.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());gen.generateKey();}
        SecretKey key=(SecretKey)store.getKey(alias,null);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        if(encrypt){cipher.init(Cipher.ENCRYPT_MODE,key);return Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);}
        String[] parts=value.split(":",2);cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }
    private void saveKey(String id,String key)throws Exception{if(!id.matches("wechat|deepseek|custom-[a-z0-9-]{8,64}"))throw new IOException("无效渠道");prefs().edit().putString(id,crypt(key,true)).commit();}
    private String key(String id)throws Exception{String value=prefs().getString(id,"");return value.isEmpty()?"":crypt(value,false);}
    private Set<String> serviceIds(){Set<String> result=new LinkedHashSet<>(Arrays.asList("wechat","deepseek"));for(String name:prefs().getAll().keySet())if(name.matches("custom-[a-z0-9-]{8,64}"))result.add(name);return result;}
    private JSONObject metadata(String id)throws Exception{
        String saved=prefs().getString("metadata:"+id,"");if(!saved.isEmpty())return new JSONObject(saved);
        JSONObject result=new JSONObject();result.put("id",id);
        if(id.equals("wechat")){result.put("baseUrl","https://chatapi.weixin.qq.com/openai/v1");result.put("model","Deepseek-v4-flash");result.put("contextLimit",200000);}
        else if(id.equals("deepseek")){result.put("baseUrl","https://api.deepseek.com");result.put("model","deepseek-flash");result.put("contextLimit",1000000);}
        return result;
    }
    private void configureSecret(JSONObject args)throws Exception{
        String id=args.getString("id"),secret=args.optString("key");if(!id.matches("wechat|deepseek|custom-[a-z0-9-]{8,64}")||secret.length()>1024)throw new IOException();
        JSONObject previous=metadata(id),service=args.optJSONObject("service");if(service==null)service=previous;
        if(!id.equals(service.optString("id")))throw new IOException();
        String base=service.getString("baseUrl").replaceAll("/+$","");URI uri=new URI(base);
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null)throw new IOException();
        if(id.equals("wechat")&&!base.equals("https://chatapi.weixin.qq.com/openai/v1")||id.equals("deepseek")&&!base.equals("https://api.deepseek.com"))throw new IOException();
        int limit=service.getInt("contextLimit");if(limit<4096||limit>(id.equals("wechat")?200000:1000000))throw new IOException();
        String model=service.optString("model");if(model.isEmpty()||model.length()>150)throw new IOException();
        if(!base.equals(previous.optString("baseUrl"))&&secret.isEmpty())throw new IOException("新地址需要独立密钥");
        if(!secret.isEmpty())saveKey(id,secret);
        service.put("baseUrl",base);prefs().edit().putString("metadata:"+id,service.toString()).commit();
    }
    private synchronized void importDevelopmentKeys()throws Exception{
        if(!BuildConfig.DEBUG)return;File file=new File(context.getFilesDir(),"model-services.json");if(!file.exists())return;
        JSONObject services=new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
        for(String id:new String[]{"wechat","deepseek"})if(services.has(id))saveKey(id,services.getJSONObject(id).getString("apiKey"));
        if(!file.delete())throw new IOException("配置导入后清理失败");
    }
    @JavascriptInterface public void request(String id,String method,String payload){
        if(closed){if(method.equals("model"))responses.respond(id,object("error","原生传输已停止，模型请求未发出","dispatch","not-dispatched"),null);else responses.respond(id,"{}","原生传输已停止");return;}
        try{
            JSONObject args=new JSONObject(payload);
            if(method.equals("cancel")){String target=args.optString("id");if(jobs.contains(target)){cancelled.add(target);HttpURLConnection c=calls.remove(target);if(c!=null)c.disconnect();}return;}
            if(method.equals("permissions")||method.equals("startCapture")||method.equals("stopCapture")||method.equals("readingStatus")||method.equals("reaction")||method.equals("startVoice")||method.equals("stopVoice")||method.equals("cancelVoice")||method.equals("voiceCheck")||method.equals("exportFile")||method.equals("openWebSource")){
                if(!allowUi){respond(id,"{}","此入口没有界面操作能力");return;}
                MainActivity.ui.post(()->{
                    try{
                        MainActivity a=MainActivity.current;
                        switch(method){
                            case "permissions": if(a==null)throw new IOException();a.permissions();break;
                            case "startCapture":if(a==null)throw new IOException();a.startCapture(id,args);return;
                            case "stopCapture":if(a!=null)a.cancelCapture(args.optString("captureToken"));else MainActivity.stopCapture(context,args.optString("captureToken"));break;
                            case "reaction":if(ReadingService.instance!=null&&args.optString("captureToken").equals(ReadingService.instance.captureToken))ReadingService.instance.reaction(args.optString("text"));break;
                            case "readingStatus":if(ReadingService.instance!=null&&args.optString("captureToken").equals(ReadingService.instance.captureToken))ReadingService.instance.status(args.optString("text"),args.optBoolean("ready"));break;
                            case "startVoice":if(a==null)throw new IOException();a.startVoice(id,args.getString("token"));return;
                            case "voiceCheck":if(a==null)throw new IOException();a.checkVoice(id);return;
                            case "stopVoice":if(a!=null)a.stopVoice(args.optString("token"));break;
                            case "cancelVoice":if(a!=null)a.cancelVoice(args.optString("token"));break;
                            case "openWebSource":
                                android.net.Uri uri=android.net.Uri.parse(args.optString("url"));
                                if(a==null)throw new IOException();WebAccess.publicUrl(uri.toString());
                                a.startActivity(new Intent(Intent.ACTION_VIEW,uri));break;
                            case "exportFile":if(a==null)throw new IOException();a.export(id,args);return;
                        }respond(id,"{}",null);
                    }catch(Exception e){respond(id,"{}","请回到宜序伴读界面重试");}
                });return;
            }
            jobs.add(id);
            executor.execute(()->{
                boolean modelEntered=false;
                try{
                    if(closed||cancelled.contains(id))return;
                    importDevelopmentKeys();
                    if(method.equals("networkStatus")){respond(id,object("online",networkOnline),null);return;}
                    if(method.equals("readingSources")){
                        JSONArray list=new JSONArray();
                        for(ReadingSource source:ReadingSource.ALL){
                            JSONObject item=new JSONObject();item.put("id",source.id);item.put("name",source.name);item.put("tested",source.tested);item.put("testedVersion",source.testedVersion);
                            boolean installed=false;String version="";
                            try{android.content.pm.PackageInfo info=context.getPackageManager().getPackageInfo(source.packageName,0);installed=context.getPackageManager().getLaunchIntentForPackage(source.packageName)!=null;version=info.versionName;}catch(android.content.pm.PackageManager.NameNotFoundException ignored){}
                            item.put("installed",installed);item.put("version",version);item.put("comments",source.commentId!=null);list.put(item);
                        }
                        respond(id,list,null);return;
                    }
                    if(method.equals("saveSecret")){configureSecret(args);respond(id,"{}",null);return;}
                    if(method.equals("services")){JSONArray list=new JSONArray();for(String name:serviceIds()){JSONObject item=metadata(name);item.put("hasKey",!key(name).isEmpty());list.put(item);}respond(id,list,null);return;}
                    if(method.equals("exportSecrets")){if(!args.optBoolean("includeKeys"))throw new IOException();JSONObject result=new JSONObject();for(String name:serviceIds())result.put(name,key(name));String searchKey=prefs().getString("search-key","");JSONObject searchCfg=new JSONObject(prefs().getString("search-config","{}"));if(!searchCfg.optString("provider").equals("exa")&&!searchKey.isEmpty())result.put("search",crypt(searchKey,false));respond(id,result,null);return;}
                    if(method.equals("model")){modelEntered=true;model(id,args);return;}
                    if(method.equals("configureSearch")){
                        String raw=prefs().getString("search-config",""),secret=args.optString("key");
                        JSONObject previous=raw.isEmpty()?new JSONObject():new JSONObject(raw),cfg=WebAccess.config(args,previous);
                        boolean changed=!previous.optString("endpoint").equals(cfg.getString("endpoint"));
                        boolean anonymous=cfg.getString("provider").equals("exa");
                        if(anonymous&&!secret.isEmpty())throw new IOException("匿名模式不接收密钥");
                        if(secret.length()>2048||!anonymous&&changed&&!prefs().getString("search-key","").isEmpty()&&secret.isEmpty())throw new IOException("新地址需要独立密钥");
                        if(cfg.getString("provider").equals("tavily")&&secret.isEmpty()&&prefs().getString("search-key","").isEmpty())throw new IOException("搜索密钥未配置");
                        SharedPreferences.Editor edit=prefs().edit().putString("search-config",cfg.toString());
                        if(!secret.isEmpty())edit.putString("search-key",crypt(secret,true));edit.commit();
                        respond(id,cfg,null);return;
                    }
                    if(method.equals("search")){search(id,args);return;}
                    if(method.equals("readPage")){JSONObject cfg=new JSONObject(prefs().getString("search-config","{}"));JSONObject result=cfg.optString("provider").equals("exa")?WebAccess.fetchExa(id,args.optString("url"),calls,cancelled):WebAccess.read(id,args.optString("url"),calls,cancelled);if(!cancelled.contains(id))respond(id,result,null);return;}
                    respond(id,"{}","此原生能力尚未接入");
                }catch(Exception e){if(method.equals("model")){respond(id,object("error",modelEntered?"模型请求的结果或结算尚未确定，已停止自动重问":"模型请求未发出，请检查设备服务配置","dispatch",modelEntered?"unknown":"not-dispatched","requestId",args.optString("requestId",id)),null);return;}if(!cancelled.contains(id))respond(id,"{}",e instanceof UnknownHostException||e instanceof SocketException||e instanceof java.net.SocketTimeoutException?"NETWORK:网络连接中断，已保留本次任务":"设备请求失败，请检查服务配置与网络");}
                finally{jobs.remove(id);cancelled.remove(id);}
            });
        }catch(Exception e){if(method.equals("model"))respond(id,object("error","请求格式无效，模型请求未发出","dispatch","not-dispatched"),null);else respond(id,"{}","请求格式无效");}
    }
    private void model(String id,JSONObject args)throws Exception{
        boolean dispatchStarted=false;HttpURLConnection c=null;long started=System.currentTimeMillis();
        String requestId=args.optString("requestId",id);if(!requestId.matches("[0-9a-fA-F-]{36}"))requestId=id;
        try{
            String service=args.getString("serviceId");JSONObject metadata=metadata(service);String expected=metadata.optString("baseUrl");
            if(expected.isEmpty()||!expected.equals(args.getString("baseUrl")))throw new IOException("渠道不符");
            String secret=key(service);if(secret.isEmpty())throw new IOException("密钥未配置");
            JSONObject body=args.getJSONObject("body");int contextLimit=metadata.getInt("contextLimit");
            if(!body.optString("model").equals(metadata.optString("model")))throw new IOException("模型尚未保存启用");
            int output=body.optInt("max_tokens");if(output<256||output>65536)throw new IOException("输出预算无效");
            if(body.toString().getBytes(StandardCharsets.UTF_8).length+output+2048>contextLimit)throw new IOException("上下文超过限制");
            c=(HttpURLConnection)new URL(expected+"/chat/completions").openConnection();calls.put(id,c);
            if(closed||cancelled.contains(id))return;c.setInstanceFollowRedirects(false);c.setConnectTimeout(20000);c.setReadTimeout(1200000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("Authorization","Bearer "+secret);
            dispatchStarted=true;
            android.util.Log.i("YixuModel",new JSONObject().put("requestId",requestId).put("stage","dispatch-started").toString());
            try(OutputStream out=c.getOutputStream()){if(closed||cancelled.contains(id))return;out.write(body.toString().getBytes(StandardCharsets.UTF_8));}
            int status=c.getResponseCode();InputStream input=status>=400?c.getErrorStream():c.getInputStream();if(input==null)throw new IOException();
            ByteArrayOutputStream buffer=new ByteArrayOutputStream();byte[] bytes=new byte[8192];int n;while((n=input.read(bytes))!=-1){buffer.write(bytes,0,n);if(buffer.size()>2000000)throw new IOException("响应过大");}input.close();
            JSONObject result=new JSONObject();result.put("status",status);result.put("body",new JSONObject(buffer.toString("UTF-8")));
            android.util.Log.i("YixuModel",new JSONObject().put("requestId",requestId).put("stage","response-received").put("status",status).put("elapsedMs",System.currentTimeMillis()-started).toString());
            respond(id,result,null);
        }catch(Exception e){
            android.util.Log.i("YixuModel",new JSONObject().put("requestId",requestId).put("stage",dispatchStarted?"unknown":"not-dispatched").put("elapsedMs",System.currentTimeMillis()-started).toString());
            if(!cancelled.contains(id)){JSONObject result=new JSONObject().put("requestId",requestId).put("dispatch",dispatchStarted?"unknown":"not-dispatched").put("error",dispatchStarted?"模型请求的结果或结算尚未确定，已停止自动重问":"模型请求未发出，请检查设备服务配置");respond(id,result,null);}
        }finally{calls.remove(id);if(c!=null)c.disconnect();}
    }
    private void search(String id,JSONObject args)throws Exception{
        String raw=prefs().getString("search-config", ""),secret=prefs().getString("search-key", "");
        JSONObject cfg=raw.isEmpty()?null:new JSONObject(raw);
        Object result=WebAccess.search(id,args,cfg,cfg!=null&&cfg.optString("provider").equals("exa")||secret.isEmpty()?"":crypt(secret,false),calls,cancelled);
        if(!cancelled.contains(id))respond(id,result,null);
    }
}
