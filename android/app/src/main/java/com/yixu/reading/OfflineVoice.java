package com.yixu.reading;

import android.content.Context;
import android.media.*;
import android.os.SystemClock;
import com.k2fsa.sherpa.onnx.*;
import java.io.*;
import java.nio.*;
import java.nio.file.Files;
import java.util.concurrent.*;
import org.json.JSONObject;

/** On-demand local ASR. Audio stays on device; cancel/end releases the recorder. */
final class OfflineVoice {
    private final Context context;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private OnlineRecognizer recognizer;
    private volatile AudioRecord recorder;
    private volatile boolean recording=false,send=false;
    private volatile String pendingDraft;
    private volatile String draftToken;
    private volatile int generation=0;
    OfflineVoice(Context context){this.context=context.getApplicationContext();}
    private void load(){
        if(recognizer!=null)return;
        OnlineTransducerModelConfig transducer=new OnlineTransducerModelConfig();
        transducer.setEncoder("voice/encoder-epoch-99-avg-1.int8.onnx");transducer.setDecoder("voice/decoder-epoch-99-avg-1.onnx");transducer.setJoiner("voice/joiner-epoch-99-avg-1.int8.onnx");
        OnlineModelConfig model=new OnlineModelConfig();model.setTransducer(transducer);model.setTokens("voice/tokens.txt");model.setNumThreads(2);model.setDebug(false);model.setProvider("cpu");
        OnlineRecognizerConfig config=new OnlineRecognizerConfig();config.setModelConfig(model);config.setEnableEndpoint(false);config.setDecodingMethod("greedy_search");
        recognizer=new OnlineRecognizer(context.getAssets(),config);
    }
    private void accept(OnlineStream stream,float[] samples,int rate){stream.acceptWaveform(samples,rate);while(recognizer.isReady(stream))recognizer.decode(stream);}
    private String finish(OnlineStream stream){accept(stream,new float[8000],16000);stream.inputFinished();while(recognizer.isReady(stream))recognizer.decode(stream);return recognizer.getResult(stream).getText().trim();}
    private JSONObject payload(String text,String token){JSONObject result=MainActivity.object("text",text);try{result.put("token",token);}catch(Exception ignored){}return result;}
    void start(String requestId,String token){
        cancel();recording=true;int ticket=generation;
        worker.execute(()->{
            AudioRecord audio=null;OnlineStream stream=null;boolean started=false;
            try{
                load();if(ticket!=generation||!recording){MainActivity.respond(requestId,"{}","录音已取消");return;}
                int minimum=AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
                audio=new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,Math.max(minimum,16000));
                if(audio.getState()!=AudioRecord.STATE_INITIALIZED)throw new IOException("麦克风未就绪");
                stream=recognizer.createStream("");recorder=audio;recording=true;send=false;audio.startRecording();started=true;MainActivity.respond(requestId,"{}",null);
                short[] pcm=new short[1600];long begin=SystemClock.elapsedRealtime();
                while(recording&&ticket==generation){
                    int count=audio.read(pcm,0,pcm.length);if(count<0){if(recording)throw new IOException("录音中断");break;}
                    if(count>0){float[] samples=new float[count];for(int i=0;i<count;i++)samples[i]=pcm[i]/32768f;accept(stream,samples,16000);}
                    if(SystemClock.elapsedRealtime()-begin>=120000){recording=false;send=false;break;}
                }
                if(ticket==generation){String text=finish(stream);if(ticket!=generation)return;if(!send){pendingDraft=text;draftToken=token;}MainActivity.event(send?"voice":"voiceDraft",payload(text,token));}
            }catch(Throwable e){
                if(ticket==generation){if(!started)MainActivity.respond(requestId,"{}","本地语音未能启动，请检查麦克风权限与语音文件");else {JSONObject error=payload("",token);try{error.put("message","本地语音处理中断，请重新录音");}catch(Exception ignored){}MainActivity.event("voiceError",error);}}
            }finally{
                if(audio!=null){try{audio.stop();}catch(Exception ignored){}audio.release();}
                if(stream!=null)stream.release();if(ticket==generation){recording=false;recorder=null;}
            }
        });
    }
    void stop(){if(pendingDraft!=null){String text=pendingDraft,token=draftToken;pendingDraft=null;draftToken=null;MainActivity.event("voice",payload(text,token));return;}send=true;recording=false;AudioRecord audio=recorder;if(audio!=null)try{audio.stop();}catch(Exception ignored){}}
    void cancel(){generation++;recording=false;send=false;pendingDraft=null;draftToken=null;AudioRecord audio=recorder;recorder=null;if(audio!=null)try{audio.stop();}catch(Exception ignored){}}
    void close(){cancel();worker.execute(()->{if(recognizer!=null){recognizer.release();recognizer=null;}});worker.shutdown();}
    void check(String requestId){
        if(!BuildConfig.DEBUG){MainActivity.respond(requestId,"{}","此检查仅用于本地原型联调");return;}
        if(recording){MainActivity.respond(requestId,"{}","请先结束当前录音");return;}
        worker.execute(()->{
            OnlineStream stream=null;
            try{
                byte[] bytes=Files.readAllBytes(new File(context.getFilesDir(),"asr-check.wav").toPath());
                if(bytes.length<44||bytes.length>2000000||!new String(bytes,0,4,"US-ASCII").equals("RIFF"))throw new IOException();
                ByteBuffer b=ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);int rate=0,start=0,size=0;
                for(int p=12;p+8<=bytes.length;){String tag=new String(bytes,p,4,"US-ASCII");int n=b.getInt(p+4);if(n<0||p+8+n>bytes.length)throw new IOException();
                    if(tag.equals("fmt ")){if(n<16||b.getShort(p+8)!=1||b.getShort(p+10)!=1||b.getShort(p+22)!=16)throw new IOException();rate=b.getInt(p+12);}
                    if(tag.equals("data")){start=p+8;size=n;}p+=8+n+(n%2);
                }
                if(start==0||rate<=0||size%2!=0)throw new IOException();
                long begin=SystemClock.elapsedRealtime();load();stream=recognizer.createStream("");float[] samples=new float[size/2];for(int i=0;i<samples.length;i++)samples[i]=b.getShort(start+i*2)/32768f;
                accept(stream,samples,rate);String text=finish(stream);JSONObject result=new JSONObject();result.put("text",text);result.put("elapsedMs",SystemClock.elapsedRealtime()-begin);result.put("audioMs",1000L*samples.length/rate);MainActivity.respond(requestId,result,null);
            }catch(Throwable e){MainActivity.respond(requestId,"{}","语音检查未完成，请核对本地测试音频和依赖");}
            finally{if(stream!=null)stream.release();}
        });
    }
}
