package com.yixu.reading;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.AtomicFile;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Debug-only entry for a fixed engineering probe; never accepts executable code. */
public final class NativeProbeActivity extends Activity {
    private final Handler handler=new Handler(Looper.getMainLooper());
    private String probeId;
    private Intent service;
    private boolean started,companionResume;
    private long deadline;
    private final Runnable awaitReport=new Runnable(){@Override public void run(){
        try{
            JSONObject report=new JSONObject(new String(new AtomicFile(new File(getFilesDir(),"native-probe-report.json")).readFully(),StandardCharsets.UTF_8));
            if(probeId.equals(report.optString("probeId"))&&"complete".equals(report.optString("status"))&&
                (!companionResume||!"companion-interruption".equals(report.optString("probe")))){finish();return;}
        }catch(Exception ignored){}
        if(SystemClock.elapsedRealtime()>=deadline){launchFailed("隔离工程探测前台等待已结束，请查看原运行；未自动重启");return;}
        handler.postDelayed(this,200);
    }};
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        probeId=getIntent().getStringExtra("probeId");
        if(probeId==null||!probeId.matches("[A-Za-z0-9_-]{1,80}")){finish();return;}
        // The NoDisplay entry could be paused for sleep before onCreate and then
        // fail startService as a background app. Keep this debug run visibly
        // foreground until its isolated service reports completion.
        if(Build.VERSION.SDK_INT>=27){setShowWhenLocked(true);setTurnScreenOn(true);}
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED|WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        TextView status=new TextView(this);status.setGravity(Gravity.CENTER);status.setTextSize(20);status.setPadding(40,40,40,40);
        status.setText("宜序伴读\n隔离工程探测正在进行\n结束后自动退出");setContentView(status);
        companionResume=getIntent().getBooleanExtra("companionResume",false);
        service=new Intent(this,NativeProbeService.class).putExtra("probeId",probeId).putExtra("realModel",getIntent().getBooleanExtra("realModel",false)).putExtra("harness",getIntent().getBooleanExtra("harness",false)).putExtra("companion",getIntent().getBooleanExtra("companion",false)).putExtra("companionResume",companionResume).putExtra("readingEmpty",getIntent().getBooleanExtra("readingEmpty",false)).putExtra("largeCharacters",getIntent().getIntExtra("largeCharacters",0)).putExtra("authorization",getIntent().getStringExtra("authorization"));
        service.putExtra("companionCorrection",getIntent().getBooleanExtra("companionCorrection",false));
        started=state!=null&&state.getBoolean("probeStarted",false);
        deadline=state==null?SystemClock.elapsedRealtime()+(getIntent().getBooleanExtra("realModel",false)?180000:40000):state.getLong("probeDeadline");
    }
    @Override public void onResume(){
        super.onResume();if(service==null)return;
        if(!started){started=true;try{if(startService(service)==null){launchFailed("隔离工程服务未启动");return;}}catch(Exception error){launchFailed(error.toString());return;}}
        handler.removeCallbacks(awaitReport);handler.post(awaitReport);
    }
    private void launchFailed(String error){
        try{
            JSONObject report=new JSONObject();report.put("probeId",probeId);report.put("probe","native-entry");report.put("status","complete");report.put("ok",false);report.put("error",error);
            AtomicFile file=new AtomicFile(new File(getFilesDir(),"native-probe-report.json"));FileOutputStream stream=null;
            try{stream=file.startWrite();stream.write(report.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(stream);}catch(Exception failure){if(stream!=null)file.failWrite(stream);}
        }catch(Exception ignored){}
        finish();
    }
    @Override public void onSaveInstanceState(Bundle state){state.putBoolean("probeStarted",started);state.putLong("probeDeadline",deadline);super.onSaveInstanceState(state);}
    @Override public void onDestroy(){handler.removeCallbacksAndMessages(null);super.onDestroy();}
}
