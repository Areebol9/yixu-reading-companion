package com.yixu.reading;
import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.view.accessibility.*;
import java.util.List;

public class SourceService extends AccessibilityService {
    static SourceService instance;
    static volatile boolean connected=false,active=false,comments=false;
    static volatile ReadingSource source=ReadingSource.QIDIAN;
    private boolean seenReader=false;
    @Override protected void onServiceConnected(){connected=true;instance=this;}
    static void select(ReadingSource next){
        if(instance!=null){instance.setActive(false);instance.seenReader=false;}
        source=next;active=false;comments=false;
    }
    static boolean confirmReading(){
        return readingBounds()!=null;
    }
    static Rect readingBounds(){
        if(instance==null||ReadingService.instance==null)return null;
        AccessibilityNodeInfo root=instance.getRootInActiveWindow();
        if(root==null)return null;
        int kind=instance.classify(root);Rect bounds=new Rect();root.getBoundsInScreen(bounds);root.recycle();comments=kind==2;
        return kind>0&&!bounds.isEmpty()?bounds:null;
    }
    private boolean visibleId(AccessibilityNodeInfo root,String suffix){
        List<AccessibilityNodeInfo> nodes=root.findAccessibilityNodeInfosByViewId(source.packageName+":id/"+suffix);boolean found=false;
        for(AccessibilityNodeInfo node:nodes){found|=node.isVisibleToUser();node.recycle();}return found;
    }
    private int classify(AccessibilityNodeInfo root){
        String name=root.getPackageName()==null?"":root.getPackageName().toString();
        int kind=source.classify(name,seenReader,item->visibleId(root,item));
        if(kind==1)seenReader=true;else if(kind==0)seenReader=false;
        return kind;
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent event){
        if(ReadingService.instance==null){setActive(false);return;}
        AccessibilityNodeInfo root=getRootInActiveWindow();
        if(root==null){setActive(false);return;}
        int kind=classify(root);comments=kind==2;setActive(kind>0);
        root.recycle();
    }
    private void setActive(boolean next){
        next=next&&ReadingService.instance!=null&&source.id.equals(ReadingService.instance.sourceId);
        if(active!=next){active=next;if(ReadingService.instance!=null){ReadingService.instance.captureVisible(next);org.json.JSONObject payload=ReadingService.instance.metadata();try{payload.put("active",next);}catch(Exception ignored){}MainActivity.event("source",payload);}}
    }
    @Override public void onInterrupt(){setActive(false);}
    @Override public void onDestroy(){connected=false;instance=null;setActive(false);super.onDestroy();}
}
