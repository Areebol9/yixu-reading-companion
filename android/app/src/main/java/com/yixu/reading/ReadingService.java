package com.yixu.reading;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.*;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.*;
import android.os.*;
import android.util.DisplayMetrics;
import android.view.*;
import android.widget.*;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.*;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.util.*;

public class ReadingService extends Service {
    static ReadingService instance;
    String captureToken="",sourceId="";
    JSONObject metadata(){JSONObject value=new JSONObject();try{value.put("captureToken",captureToken);value.put("sourceId",sourceId);}catch(Exception ignored){}return value;}
    private final Handler handler=new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader images;
    private TextRecognizer recognizer;
    private WindowManager windows;
    private TextView pointer,ball,reaction;
    private WindowManager.LayoutParams pointerParams,ballParams;
    private int width,height,density,boundary,top,generation=0;
    private boolean processing=false,stopped=false,reacting=false;
    private long lastHash=Long.MIN_VALUE,geometryChangedAt;
    private String lastText="",lastCoverage="";
    private final Runnable tick=new Runnable(){public void run(){if(stopped)return;try{capture();}catch(Exception e){MainActivity.event("error",MainActivity.object("message","屏幕处理暂时中断，请重新开启跟随"));}handler.postDelayed(this,900);}};

    @Override public void onCreate(){super.onCreate();instance=this;windows=(WindowManager)getSystemService(WINDOW_SERVICE);recognizer=TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent==null||projection!=null)return START_NOT_STICKY;
        captureToken=intent.getStringExtra("captureToken");if(captureToken==null||captureToken.isEmpty()){stopSelf();return START_NOT_STICKY;}
        sourceId=intent.getStringExtra("sourceId");if(ReadingSource.find(sourceId)==null||!SourceService.source.id.equals(sourceId)){stopSelf();return START_NOT_STICKY;}
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel("reading","共读状态",NotificationManager.IMPORTANCE_LOW));
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification=new Notification.Builder(this,"reading").setSmallIcon(android.R.drawable.ic_menu_view).setContentTitle("宜序伴读正在跟随").setContentText("仅处理阅读应用与指针以上的选定区域").setContentIntent(open).setOngoing(true).build();
        startForeground(17,notification);
        try{
            DisplayMetrics metrics=new DisplayMetrics();windows.getDefaultDisplay().getRealMetrics(metrics);width=metrics.widthPixels;height=metrics.heightPixels;density=metrics.densityDpi;boundary=height/3;
            int statusBar=getResources().getIdentifier("status_bar_height","dimen","android");top=statusBar==0?dp(24):getResources().getDimensionPixelSize(statusBar);
            MediaProjectionManager projections=(MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE);
            Intent data=intent.getParcelableExtra("data");projection=projections.getMediaProjection(intent.getIntExtra("code",Activity.RESULT_CANCELED),data);
            projection.registerCallback(new MediaProjection.Callback(){@Override public void onStop(){stopSelf();}},handler);
            images=ImageReader.newInstance(width,height,PixelFormat.RGBA_8888,2);
            display=projection.createVirtualDisplay("yixu-reading",width,height,density,0,images.getSurface(),null,handler);
            overlays();captureVisible(false);handler.postDelayed(tick,900);
        }catch(Exception e){MainActivity.event("error",MainActivity.object("message","屏幕采集未能启动，请检查系统权限"));stopSelf();}
        return START_NOT_STICKY;
    }
    private int dp(float value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private TextView label(String text){TextView view=new TextView(this);view.setText(text);view.setTextColor(Color.WHITE);view.setTextSize(12);view.setGravity(Gravity.CENTER);view.setPadding(dp(12),dp(8),dp(12),dp(8));android.graphics.drawable.GradientDrawable bg=new android.graphics.drawable.GradientDrawable();bg.setColor(0xff245c4e);bg.setCornerRadius(dp(18));view.setBackground(bg);return view;}
    private WindowManager.LayoutParams params(int w,int h){WindowManager.LayoutParams p=new WindowManager.LayoutParams(w,h,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE|WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,PixelFormat.TRANSLUCENT);p.gravity=Gravity.TOP|Gravity.LEFT;p.flags|=WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;return p;}
    private void overlays(){
        pointer=label("◀");pointer.setPadding(0,0,0,0);pointer.setContentDescription("拖动阅读边界，轻点打开共读交流");pointerParams=params(dp(29),dp(31));pointerParams.x=width-dp(32);pointerParams.y=boundary;windows.addView(pointer,pointerParams);
        pointer.setOnClickListener(v->openDiscussion());
        pointer.setOnTouchListener(new View.OnTouchListener(){float downY,downX;int original;boolean moved;public boolean onTouch(View v,android.view.MotionEvent e){switch(e.getAction()){case MotionEvent.ACTION_DOWN:downY=e.getRawY();downX=e.getRawX();original=pointerParams.y;moved=false;return true;case MotionEvent.ACTION_MOVE:if(!moved&&Math.abs(e.getRawY()-downY)<=dp(4)&&Math.abs(e.getRawX()-downX)<=dp(4))return true;moved=true;boundary=Math.max(top+dp(40),Math.min(height-pointerParams.height,original+Math.round(e.getRawY()-downY)));pointerParams.y=boundary;generation++;lastHash=Long.MIN_VALUE;geometryChangedAt=SystemClock.elapsedRealtime();windows.updateViewLayout(pointer,pointerParams);positionBall();if(reaction!=null){try{windows.removeView(reaction);}catch(Exception ignored){}reaction=null;reacting=false;}return true;case MotionEvent.ACTION_UP:if(!moved)v.performClick();return true;case MotionEvent.ACTION_CANCEL:return true;}return false;}});
        ball=label("序");ball.setTextSize(20);ball.setContentDescription("打开共读交流，长按控制");ballParams=params(dp(48),dp(48));ballParams.x=width-dp(59);ballParams.y=height-dp(200);windows.addView(ball,ballParams);positionBall();
        ball.setOnClickListener(v->openDiscussion());
        ball.setOnLongClickListener(v->{PopupMenu menu=new PopupMenu(this,ball);menu.getMenu().add("安静／恢复交流");menu.getMenu().add("结束共读");menu.setOnMenuItemClickListener(item->{if(item.getTitle().equals("结束共读")){MainActivity.event("stop",metadata());stopSelf();}else MainActivity.event("quiet",metadata());return true;});menu.show();return true;});
    }
    private void openDiscussion(){MainActivity.event("openConversation",metadata());Intent open=new Intent(this,MainActivity.class);open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);startActivity(open);}
    private void positionBall(){
        if(ball==null||ballParams==null)return;
        int y=Math.max(height-dp(200),boundary+dp(38));
        // At the page bottom, the pointer is also the discussion entry. Keep the
        // extra control hidden instead of moving it over the first line of text.
        if(y+dp(48)>height-dp(10)){ball.setVisibility(View.GONE);return;}
        ball.setVisibility(SourceService.active?View.VISIBLE:View.GONE);
        if(ballParams.y!=y){ballParams.y=y;windows.updateViewLayout(ball,ballParams);}
    }
    private void capture(){
        if(images==null)return;
        Image image=images.acquireLatestImage();if(image==null)return;
        if(stopped||processing||SystemClock.elapsedRealtime()-geometryChangedAt<150||!sourceId.equals(SourceService.source.id)||!SourceService.active){image.close();return;}
        final Rect readingWindow=SourceService.readingBounds();if(readingWindow==null){image.close();return;}
        int left=Math.max(0,readingWindow.left),right=Math.min(width,readingWindow.right),cropTop=Math.max(top,readingWindow.top),bottom=Math.min(boundary-dp(3),readingWindow.bottom);
        if(bottom<=cropTop||right<=left||image.getWidth()!=width||image.getHeight()!=height){image.close();return;}
        Image.Plane plane=image.getPlanes()[0];ByteBuffer buffer=plane.getBuffer();int pixelStride=plane.getPixelStride(),rowStride=plane.getRowStride();
        Bitmap full=Bitmap.createBitmap(width+(rowStride-pixelStride*width)/pixelStride,height,Bitmap.Config.ARGB_8888);full.copyPixelsFromBuffer(buffer);image.close();
        // Crop before any recognition/model. No full-screen fallback on invalid geometry.
        Bitmap crop=Bitmap.createBitmap(full,left,cropTop,right-left,bottom-cropTop);full.recycle();
        final Rect control=ballParams==null||ball==null||ball.getVisibility()!=View.VISIBLE?null:new Rect(ballParams.x-left,ballParams.y-cropTop,ballParams.x-left+ballParams.width,ballParams.y-cropTop+ballParams.height);
        long hash=1125899906842597L;int sx=Math.max(1,crop.getWidth()/26),sy=Math.max(1,crop.getHeight()/26);
        for(int y=0;y<crop.getHeight();y+=sy)for(int x=0;x<crop.getWidth();x+=sx)hash=31*hash+crop.getPixel(x,y);
        if(hash==lastHash){crop.recycle();return;}lastHash=hash;
        processing=true;final int ticket=generation;final boolean comments=SourceService.comments;long started=SystemClock.elapsedRealtime();
        recognizer.process(InputImage.fromBitmap(crop,0)).addOnSuccessListener(text->{
            if(stopped||ticket!=generation||!sourceId.equals(SourceService.source.id)||!SourceService.active)return;
            Rect currentWindow=SourceService.readingBounds();if(!readingWindow.equals(currentWindow)||comments!=SourceService.comments){lastHash=Long.MIN_VALUE;return;}
            List<Text.Line> lines=new ArrayList<>();for(Text.TextBlock block:text.getTextBlocks())lines.addAll(block.getLines());
            lines.sort(Comparator.comparingInt(l->l.getBoundingBox()==null?0:l.getBoundingBox().top));
            List<Integer> sizes=new ArrayList<>();for(Text.Line line:lines)if(line.getBoundingBox()!=null&&line.getText().length()>4)sizes.add(line.getBoundingBox().height());Collections.sort(sizes);int median=sizes.isEmpty()?0:sizes.get(sizes.size()/2);
            StringBuilder joined=new StringBuilder();List<ReadingLayout.Line> layout=new ArrayList<>();for(Text.Line line:lines){Rect box=line.getBoundingBox();if(box!=null&&box.bottom<=crop.getHeight()&&(control==null||!Rect.intersects(box,control))&&!(line.getText().matches("[0-9]{1,4}")&&box.height()<median*.65)){joined.append(line.getText()).append('\n');layout.add(new ReadingLayout.Line(box.left,box.top,box.right,box.bottom,line.getText().length()));}}
            String value=joined.toString().trim();if(value.length()<10)return;
            String coverage=!comments&&height>width&&ReadingLayout.singleColumn(layout,crop.getWidth(),crop.getHeight())?"continuous-page":"fragments";
            if(value.equals(lastText)&&coverage.equals(lastCoverage))return;lastText=value;lastCoverage=coverage;
            JSONObject payload=metadata();try{payload.put("text",value);payload.put("kind",comments?"comment":"body");payload.put("coverage",coverage);payload.put("ocrMs",SystemClock.elapsedRealtime()-started);payload.put("boundary",boundary);}catch(Exception ignored){}
            MainActivity.event("observation",payload);
            if(BuildConfig.DEBUG)android.util.Log.i("YixuCapture","recognized chars="+value.length()+" ms="+(SystemClock.elapsedRealtime()-started)+" boundary="+boundary+" kind="+(comments?"comment":"body")+" coverage="+coverage+" crop="+left+","+cropTop+","+right+","+bottom);
        }).addOnFailureListener(e->{lastHash=Long.MIN_VALUE;MainActivity.event("error",MainActivity.object("message","本地文字识别暂不可用"));}).addOnCompleteListener(task->{crop.recycle();processing=false;});
    }
    public void captureVisible(boolean visible){
        generation++;lastHash=Long.MIN_VALUE;lastText="";geometryChangedAt=SystemClock.elapsedRealtime();
        if(pointer!=null)pointer.setVisibility(visible?View.VISIBLE:View.GONE);
        if(ball!=null)ball.setVisibility(visible?View.VISIBLE:View.GONE);
        if(visible)positionBall();
        if(!visible&&reaction!=null){try{windows.removeView(reaction);}catch(Exception ignored){}reaction=null;reacting=false;}
        if(display!=null&&images!=null)try{display.setSurface(visible?images.getSurface():null);}catch(Exception e){stopSelf();}
    }
    public void status(String text,boolean ready){
        if(ball==null)return;ball.setContentDescription(text);
        android.graphics.drawable.GradientDrawable bg=new android.graphics.drawable.GradientDrawable();bg.setColor(ready?0xff245c4e:0xff9d7945);bg.setCornerRadius(dp(18));ball.setBackground(bg);
    }
    public void reaction(String text){
        if(stopped||!SourceService.active)return;
        if(reaction!=null){try{windows.removeView(reaction);}catch(Exception ignored){}}
        // Present below the authorized crop so reactions never enter OCR or suspend sampling.
        int y=Math.max(boundary+dp(34),height-dp(185)),available=height-dp(35)-y;
        if(available<dp(65)){ball.setText("聊");handler.postDelayed(()->{if(ball!=null)ball.setText("序");},4500);return;}
        reaction=label(text);reaction.setTextSize(14);reaction.setGravity(Gravity.LEFT);reaction.setMaxLines(4);reaction.setPadding(dp(17),dp(12),dp(17),dp(12));
        reaction.setMaxLines(Math.max(1,Math.min(4,(available-dp(24))/dp(22))));
        WindowManager.LayoutParams p=params(width-dp(44),WindowManager.LayoutParams.WRAP_CONTENT);p.x=dp(22);p.y=y;p.flags|=WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;p.alpha=.78f;windows.addView(reaction,p);reacting=true;
        final TextView shown=reaction;handler.postDelayed(()->{try{windows.removeView(shown);}catch(Exception ignored){}if(reaction==shown){reaction=null;reacting=false;lastHash=Long.MIN_VALUE;}},6500);
    }
    @Override public void onConfigurationChanged(Configuration config){super.onConfigurationChanged(config);MainActivity.event("error",MainActivity.object("message","屏幕方向已变化，请重新开启跟随以确认范围"));stopSelf();}
    @Override public void onDestroy(){
        stopped=true;generation++;handler.removeCallbacksAndMessages(null);instance=null;
        if(captureToken!=null&&captureToken.equals(MainActivity.activeCaptureToken))MainActivity.activeCaptureToken=null;
        if(display!=null)display.release();if(images!=null)images.close();if(projection!=null){projection.stop();projection=null;}if(recognizer!=null)recognizer.close();
        for(View view:new View[]{pointer,ball,reaction})if(view!=null)try{windows.removeView(view);}catch(Exception ignored){}
        MainActivity.event("captureStopped",metadata());super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent){return null;}
}
