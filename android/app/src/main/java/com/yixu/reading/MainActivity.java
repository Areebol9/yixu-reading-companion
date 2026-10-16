package com.yixu.reading;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.speech.*;
import android.webkit.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class MainActivity extends Activity {
    static WebView web;
    static MutableContextWrapper webContext;
    static NativeCore.ClientBridge bridge;
    static MainActivity current;
    static Boolean keyboardVisible;
    static String activeCaptureToken;
    static final Handler ui = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private String captureId, pendingCaptureToken, pendingSourceId, exportId, exportText;
    private boolean capturePending=false;
    private SpeechRecognizer speech;
    private OfflineVoice offlineVoice;
    private int voiceGeneration=0;
    private String voiceText;
    private String activeVoiceToken;
    private boolean voiceSendRequested=false;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); current=this;
        getWindow().setStatusBarColor(0xfff4f3ed);getWindow().setNavigationBarColor(0xfff4f3ed);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        if(web==null) {
            webContext=new MutableContextWrapper(this);
            web=new WebView(webContext);
            final WebView owner=web;
            owner.getViewTreeObserver().addOnGlobalLayoutListener(()->{
                if(web!=owner)return;
                android.graphics.Rect visible=new android.graphics.Rect();owner.getWindowVisibleDisplayFrame(visible);
                int screen=owner.getResources().getDisplayMetrics().heightPixels;
                boolean shown=screen-visible.bottom>screen*.18;
                if(Build.VERSION.SDK_INT>=30){WindowInsets insets=owner.getRootWindowInsets();shown=shown||(insets!=null&&insets.isVisible(WindowInsets.Type.ime()));}
                reportKeyboard(shown);
            });
            web.setBackgroundColor(0xfff4f3ed);
            WebSettings s=web.getSettings(); s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);
            s.setAllowFileAccess(false);s.setAllowContentAccess(true);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
            bridge=new NativeCore.ClientBridge(getApplicationContext());web.addJavascriptInterface(bridge,"YixuNative");
            web.setWebViewClient(new WebViewClient(){
                @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){if(view==web)rebuildRenderer();else view.destroy();return true;}
                @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return !trusted(request.getUrl());}
                @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                    Uri uri=request.getUrl();
                    if(!trusted(uri))return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
                    String path=uri.getPath();if(path==null||path.contains(".."))return null;
                    if(path.equals("/"))path="/index.html";
                    try{
                        String mime=path.endsWith(".js")?"application/javascript":path.endsWith(".css")?"text/css":path.endsWith(".html")?"text/html":path.endsWith(".json")?"application/json":"application/octet-stream";
                        return new WebResourceResponse(mime,"UTF-8",getAssets().open("web"+path));
                    }catch(IOException e){return new WebResourceResponse("text/plain","UTF-8",404,"Not found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
                }
            });
            web.loadUrl("https://appassets.androidplatform.net/index.html");
        }
        if(webContext!=null)webContext.setBaseContext(this);
        if(web.getParent() instanceof android.view.ViewGroup parent)parent.removeView(web);
        setContentView(web);
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType("*/*");intent.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(intent,10);return true;
            }
            @Override public boolean onJsConfirm(WebView v,String url,String message,JsResult result){new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("继续",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}
            @Override public boolean onJsPrompt(WebView v,String url,String message,String value,JsPromptResult result){EditText input=new EditText(MainActivity.this);input.setText(value);new AlertDialog.Builder(MainActivity.this).setMessage(message).setView(input).setPositiveButton("保存",(d,w)->result.confirm(input.getText().toString())).setNegativeButton("取消",(d,w)->result.cancel()).show();return true;}
        });
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},12);
    }
    static boolean trusted(Uri uri){return "https".equals(uri.getScheme())&&"appassets.androidplatform.net".equals(uri.getHost());}
    static void rebuildRenderer(){
        WebView old=web;web=null;webContext=null;bridge=null;keyboardVisible=null;
        if(old!=null){if(old.getParent() instanceof android.view.ViewGroup parent)parent.removeView(old);old.destroy();}
        if(current!=null)current.recreate();
    }
    static void respond(String id,Object data,String error){NativeCore core=NativeCore.peek();if(core!=null&&core.completeHost(id,data,error))return;webRespond(id,data,error);}
    static void webRespond(String id,Object data,String error){ui.post(()->{if(web!=null)web.evaluateJavascript("window.yixuNativeResult?.("+JSONObject.quote(id)+","+JSONObject.quote(String.valueOf(data))+","+(error==null?"null":JSONObject.quote(error))+")",null);});}
    static void event(String name,JSONObject payload){NativeCore core=NativeCore.peek();if(core!=null)core.event(name,payload);else webEvent(name,payload);}
    static void webEvent(String name,JSONObject payload){ui.post(()->{if(web!=null)web.evaluateJavascript("window.yixuNativeEvent?.("+JSONObject.quote(name)+","+JSONObject.quote(payload.toString())+")",null);});}
    static JSONObject object(String key,Object value){JSONObject o=new JSONObject();try{o.put(key,value);}catch(JSONException ignored){}return o;}
    static void reportKeyboard(boolean visible){if(keyboardVisible!=null&&keyboardVisible==visible)return;keyboardVisible=visible;event("keyboard",object("visible",visible));}
    void permissions(){new AlertDialog.Builder(this).setTitle("外部阅读权限").setMessage("悬浮权限用于阅读指针和短回应；页面识别用于离开所选应用时停止处理。屏幕采集会在每次开始时单独请求。").setPositiveButton("悬浮权限",(d,w)->startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+getPackageName())))).setNeutralButton("页面识别",(d,w)->startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))).setNegativeButton("返回",null).show();}
    void startCapture(String id,JSONObject options){
        ReadingSource source=ReadingSource.find(options.optString("sourceId"));
        if(source==null){respond(id,"{}","请先选择已适配的阅读应用");return;}
        if(getPackageManager().getLaunchIntentForPackage(source.packageName)==null){respond(id,"{}","所选阅读应用当前不可打开，请检查是否已安装");return;}
        if(capturePending){respond(id,"{}","正在等待系统采集确认，请先完成当前操作");return;}
        if(!Settings.canDrawOverlays(this)){respond(id,"{}","请先开启悬浮权限");permissions();return;}
        if(!SourceService.connected){respond(id,"{}","请先在无障碍设置中开启宜序伴读页面识别");permissions();return;}
        String token=options.optString("captureToken");if(token.isEmpty()){respond(id,"{}","共读标识无效");return;}
        if(ReadingService.instance!=null){if(token.equals(ReadingService.instance.captureToken)&&source.id.equals(ReadingService.instance.sourceId)){startActivity(getPackageManager().getLaunchIntentForPackage(source.packageName));respond(id,"{}",null);return;}stopService(new Intent(this,ReadingService.class));}
        SourceService.select(source);
        captureId=id;pendingCaptureToken=token;pendingSourceId=source.id;capturePending=true;MediaProjectionManager manager=(MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE);
        try{startActivityForResult(manager.createScreenCaptureIntent(),11);}catch(RuntimeException e){capturePending=false;captureId=null;pendingCaptureToken=null;pendingSourceId=null;respond(id,"{}","系统未能打开屏幕采集确认，请重试");}
    }
    void cancelCapture(){cancelCapture(null);}
    void cancelCapture(String token){
        if(token==null||token.isEmpty()||token.equals(pendingCaptureToken)){
            if(captureId!=null)respond(captureId,"{}","屏幕跟随已取消");
            captureId=null;pendingCaptureToken=null;pendingSourceId=null;
        }
        stopCapture(this,token);
    }
    static void stopCapture(Context context,String token){
        ReadingService service=ReadingService.instance;
        String active=activeCaptureToken!=null?activeCaptureToken:service==null?null:service.captureToken;
        if(token==null||token.isEmpty()||token.equals(active)){
            activeCaptureToken=null;
            context.stopService(new Intent(context,ReadingService.class));
        }
    }
    void export(String id,JSONObject args){exportId=id;exportText=args.optString("text");Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("application/json");intent.putExtra(Intent.EXTRA_TITLE,args.optString("name","宜序伴读备份.json"));startActivityForResult(intent,13);}
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==10){if(fileCallback!=null){fileCallback.onReceiveValue(result==RESULT_OK&&data!=null?new Uri[]{data.getData()}:null);fileCallback=null;}}
        if(request==11){
            capturePending=false;if(captureId==null)return;
            try{
                if(result==RESULT_OK&&data!=null){
                    ReadingSource source=ReadingSource.find(pendingSourceId);
                    if(source==null||source!=SourceService.source)throw new IOException();
                    Intent reader=getPackageManager().getLaunchIntentForPackage(source.packageName);if(reader==null)throw new IOException();
                    Intent service=new Intent(this,ReadingService.class);service.putExtra("code",result);service.putExtra("data",data);service.putExtra("captureToken",pendingCaptureToken);service.putExtra("sourceId",pendingSourceId);activeCaptureToken=pendingCaptureToken;startForegroundService(service);respond(captureId,"{}",null);startActivity(reader);
                }else respond(captureId,"{}","未开启屏幕采集");
            }catch(Exception e){stopService(new Intent(this,ReadingService.class));respond(captureId,"{}","所选应用或屏幕采集已不可用，请重新开启");}
            finally{captureId=null;pendingCaptureToken=null;pendingSourceId=null;}
        }
        if(request==13){try{if(result!=RESULT_OK||data==null)throw new IOException();try(OutputStream out=getContentResolver().openOutputStream(data.getData())){out.write(exportText.getBytes(StandardCharsets.UTF_8));}respond(exportId,"{}",null);}catch(Exception e){respond(exportId,"{}","导出已取消或无法保存");}finally{exportText=null;exportId=null;}}
    }
    void startVoice(String id,String token){
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},14);respond(id,"{}","请授权麦克风后重新开始录音");return;}
        cancelVoice();activeVoiceToken=token;if(offlineVoice==null)offlineVoice=new OfflineVoice(this);offlineVoice.start(id,token);
    }
    void checkVoice(String id){if(offlineVoice==null)offlineVoice=new OfflineVoice(this);offlineVoice.check(id);}
    void startSystemVoice(String id){
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},14);respond(id,"{}","请授权麦克风后重新开始录音");return;}
        if(!SpeechRecognizer.isRecognitionAvailable(this)){respond(id,"{}","设备没有可用的语音识别服务，稍后可配置独立语音渠道");return;}
        cancelVoice();final int ticket=voiceGeneration;voiceText=null;voiceSendRequested=false;
        speech=Build.VERSION.SDK_INT>=31&&SpeechRecognizer.isOnDeviceRecognitionAvailable(this)?SpeechRecognizer.createOnDeviceSpeechRecognizer(this):SpeechRecognizer.createSpeechRecognizer(this);
        speech.setRecognitionListener(new RecognitionListener(){
            public void onReadyForSpeech(Bundle p){}public void onBeginningOfSpeech(){}public void onRmsChanged(float f){}public void onBufferReceived(byte[] b){}public void onEndOfSpeech(){}public void onPartialResults(Bundle r){}public void onEvent(int t,Bundle p){}
            public void onError(int e){if(ticket!=voiceGeneration)return;cancelVoice();event("voiceError",object("message","语音识别暂不可用，错误码 "+e));}
            public void onResults(Bundle r){
                if(ticket!=voiceGeneration)return;ArrayList<String> values=r.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);voiceText=values==null||values.isEmpty()?"":values.get(0);
                if(voiceSendRequested){String value=voiceText;cancelVoice();event("voice",object("text",value));}
                else event("voiceDraft",object("text",voiceText));
            }
        });
        Intent i=new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);i.putExtra(RecognizerIntent.EXTRA_LANGUAGE,"zh-CN");i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE,true);speech.startListening(i);respond(id,"{}",null);
    }
    void stopVoice(String token){if(token==null||token.isEmpty()||token.equals(activeVoiceToken))stopVoice();}
    void stopVoice(){
        if(offlineVoice!=null){offlineVoice.stop();return;}
        voiceSendRequested=true;
        if(voiceText!=null){String value=voiceText;cancelVoice();event("voice",object("text",value));}
        else if(speech!=null)speech.stopListening();
    }
    void cancelVoice(String token){if(token==null||token.isEmpty()||token.equals(activeVoiceToken))cancelVoice();}
    void cancelVoice(){activeVoiceToken=null;if(offlineVoice!=null)offlineVoice.cancel();voiceGeneration++;voiceSendRequested=false;voiceText=null;if(speech!=null){speech.cancel();speech.destroy();speech=null;}}
    @Override protected void onDestroy(){
        if(captureId!=null)cancelCapture(pendingCaptureToken);
        if(activeVoiceToken!=null){JSONObject value=object("token",activeVoiceToken);try{value.put("message","录音界面已关闭，本次录音已取消");}catch(JSONException ignored){}event("voiceError",value);}
        if(current==this){current=null;if(webContext!=null)webContext.setBaseContext(getApplicationContext());}
        cancelVoice();if(offlineVoice!=null)offlineVoice.close();super.onDestroy();
    }
    @Override public void onBackPressed(){moveTaskToBack(true);}
}
