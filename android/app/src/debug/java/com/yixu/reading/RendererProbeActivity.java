package com.yixu.reading;
import android.app.Activity;
import android.os.*;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** Fixed renderer destruction/recreation check. Does not execute user code or models. */
public final class RendererProbeActivity extends Activity {
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        final JSONObject report=new JSONObject();
        try{
            NativeCore core=NativeCore.peek();if(core==null||MainActivity.current==null||MainActivity.web==null)throw new IOException("先打开正常宜序客户端");
            report.put("before",core.debugIdentity());report.put("oldRenderer",System.identityHashCode(MainActivity.web));
            MainActivity.rebuildRenderer();
            new Handler(Looper.getMainLooper()).postDelayed(()->{
                try{
                    report.put("after",core.debugIdentity());report.put("newRenderer",System.identityHashCode(MainActivity.web));
                    report.put("ok",MainActivity.web!=null&&report.getInt("oldRenderer")!=report.getInt("newRenderer")&&report.getJSONObject("before").getString("epoch").equals(report.getJSONObject("after").getString("epoch"))&&!report.getJSONObject("after").getBoolean("failed"));
                    write(report);
                }catch(Exception e){try{report.put("ok",false);report.put("error",e.toString());write(report);}catch(Exception ignored){}}
            },1200);
        }catch(Exception e){try{report.put("ok",false);report.put("error",e.toString());write(report);}catch(Exception ignored){}}
        finish();
    }
    private void write(JSONObject report)throws Exception{
        AtomicFile file=new AtomicFile(new File(getFilesDir(),"renderer-probe-report.json"));FileOutputStream out=null;
        try{out=file.startWrite();out.write(report.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(out);}catch(Exception e){if(out!=null)file.failWrite(out);throw e;}
    }
}
