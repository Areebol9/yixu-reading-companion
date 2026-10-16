package com.yixu.reading;

import android.util.AtomicFile;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.security.MessageDigest;
import java.security.DigestInputStream;
import java.util.HashMap;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.Iterator;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

/** Immutable prose/material files and typed metadata in a SQLite transaction. */
final class NativeFileStore {
    private final File root,texts,memoryBodies;
    private final File taskMaterials;
    private final SQLiteDatabase database;
    private static final String[] COLLECTIONS={"books","memories","chats","conversations","partners","usage","forgotten","transcriptRevisions","habits","tasks","readings","readingDrafts","queryCheckpoints","entityRoots","companionWorkspaces","companionReadingReceipts","companionCorrectionRepairs","publishedViews","viewPublications","maintenanceJobs"};
    private static final Set<String> COLLECTION_SET=new HashSet<>(Arrays.asList(COLLECTIONS));
    private int textWrites,metadataWrites;
    private long rangeBytesRead,rangeReads;
    private final HashMap<String,Integer> lengths=new HashMap<>();
    NativeFileStore(File root)throws IOException{
        this.root=root;this.texts=new File(root,"texts");this.memoryBodies=new File(root,"memory-bodies");
        if(!texts.isDirectory()&&!texts.mkdirs())throw new IOException("无法建立资料存储目录");
        if(!memoryBodies.isDirectory()&&!memoryBodies.mkdirs())throw new IOException("无法建立阅读档案正文目录");
        taskMaterials=new File(root,"task-materials");if(!taskMaterials.isDirectory()&&!taskMaterials.mkdirs())throw new IOException("无法建立任务材料目录");
        File dbFile=new File(root,"metadata.sqlite");
        if(exists(new File(root,"records-authority"))&&!dbFile.exists())throw new IOException("局部资料库缺失，请显式导入备份，未回退旧档");
        database=SQLiteDatabase.openOrCreateDatabase(dbFile,null);database.enableWriteAheadLogging();
        database.execSQL("CREATE TABLE IF NOT EXISTS head(k TEXT PRIMARY KEY,json TEXT NOT NULL)");
        database.execSQL("CREATE TABLE IF NOT EXISTS entities(collection TEXT NOT NULL,k TEXT NOT NULL,json TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(collection,k))");
    }
    private File textFile(String version)throws IOException{
        if(!version.matches("[0-9a-f]{64}"))throw new IOException("原文版本无效");
        return new File(texts,version+".utf8");
    }
    private static void write(File path,byte[] value)throws IOException{
        AtomicFile file=new AtomicFile(path);FileOutputStream stream=null;
        try{stream=file.startWrite();stream.write(value);file.finishWrite(stream);}catch(IOException e){if(stream!=null)file.failWrite(stream);throw e;}
    }
    private static boolean exists(File path){return path.exists()||new File(path.getPath()+".bak").exists();}
    synchronized void putBookText(JSONObject data)throws Exception{
        String version=data.getString("version"),text=data.getString("text");File target=textFile(version);
        if(text.isEmpty()||text.length()>30000000)throw new IOException("原文为空或超过当前支持体积");
        if(target.exists()){
            if(!Utf8Text.hash(text).equals(version))throw new IOException("原文与版本校验不一致");
            try(InputStream in=new AtomicFile(target).openRead()){if(!Utf8Text.hash(in).equals(version))throw new IOException("保存的原文校验失败");}
            lengths.put(version,text.length());ensureTextIndex(version,text);return;
        }
        AtomicFile file=new AtomicFile(target);FileOutputStream stream=null;
        try{
            stream=file.startWrite();MessageDigest digest=MessageDigest.getInstance("SHA-256");
            Utf8Text.write(new java.security.DigestOutputStream(stream,digest),text);
            if(!Utf8Text.hex(digest.digest()).equals(version))throw new IOException("原文与版本校验不一致");
            file.finishWrite(stream);lengths.put(version,text.length());textWrites++;
        }catch(Exception e){if(stream!=null)file.failWrite(stream);throw e;}
        ensureTextIndex(version,text);
    }
    private String scanText(String version,boolean materialize)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        StringBuilder text=materialize?new StringBuilder():null;int length=0;
        try(Reader reader=new InputStreamReader(new DigestInputStream(new AtomicFile(textFile(version)).openRead(),digest),
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT))){
            char[] buffer=new char[8192];int count;
            while((count=reader.read(buffer))!=-1){length+=count;if(length>30000000)throw new IOException("原文超过当前支持体积");if(text!=null)text.append(buffer,0,count);}
        }
        if(length==0||!Utf8Text.hex(digest.digest()).equals(version))throw new IOException("保存的原文校验失败，未继续读取");
        Integer expected=lengths.get(version);
        if(expected!=null&&expected!=length)throw new IOException("原文长度校验失败，未继续读取");
        lengths.put(version,length);return text==null?null:text.toString();
    }
    synchronized String readBookText(String version)throws Exception{return scanText(version,true);}
    private File indexFile(String version)throws IOException{textFile(version);return new File(texts,version+".ranges.json");}
    /** Index creation is import/migration work. Ordinary range reads seek only
     * the intersecting immutable chunks; no full original hash scan or String. */
    private void ensureTextIndex(String version,String supplied)throws Exception{
        if(indexFile(version).exists())return;
        String text=supplied==null?scanText(version,true):supplied;JSONArray chunks=new JSONArray();long offset=0;
        for(int start=0;start<text.length();){int end=Math.min(text.length(),start+32768);if(end<text.length()&&Character.isHighSurrogate(text.charAt(end-1))&&Character.isLowSurrogate(text.charAt(end)))end--;
            String part=text.substring(start,end);ByteArrayOutputStream buffer=new ByteArrayOutputStream();Utf8Text.write(buffer,part);byte[] bytes=buffer.toByteArray();
            chunks.put(new JSONObject().put("start",start).put("end",end).put("byteStart",offset).put("bytes",bytes.length).put("hash",Utf8Text.hash(part)));offset+=bytes.length;start=end;
        }
        if(!Utf8Text.hash(text).equals(version))throw new IOException("范围索引原文版本不符");
        write(indexFile(version),new JSONObject().put("version",version).put("length",text.length()).put("bytes",offset).put("chunks",chunks).toString().getBytes(StandardCharsets.UTF_8));
    }
    synchronized JSONObject readBookRanges(String version,JSONArray ranges)throws Exception{
        JSONObject index=new JSONObject(new String(new AtomicFile(indexFile(version)).readFully(),StandardCharsets.UTF_8));
        int length=index.getInt("length");if(!index.getString("version").equals(version)||length<=0||index.getLong("bytes")!=textFile(version).length())throw new IOException("范围索引身份不符");
        JSONArray chunks=index.getJSONArray("chunks"),pieces=new JSONArray();int previous=0;long previousByte=0;
        for(int i=0;i<chunks.length();i++){JSONObject c=chunks.getJSONObject(i);if(c.getInt("start")!=previous||c.getLong("byteStart")!=previousByte||c.getInt("end")<=previous)throw new IOException("范围索引坐标无效");previous=c.getInt("end");previousByte+=c.getInt("bytes");}if(previous!=length||previousByte!=index.getLong("bytes"))throw new IOException("范围索引长度无效");
        try(RandomAccessFile original=new RandomAccessFile(textFile(version),"r")){
            for(int r=0;r<ranges.length();r++){JSONObject range=ranges.getJSONObject(r);int start=range.getInt("start"),end=range.getInt("end");if(!(range.get("start") instanceof Number)||!(range.get("end") instanceof Number)||((Number)range.get("start")).doubleValue()!=start||((Number)range.get("end")).doubleValue()!=end||start<0||end<=start||end>length)throw new IOException("原文范围越界");StringBuilder value=new StringBuilder();
                for(int i=0;i<chunks.length();i++){JSONObject c=chunks.getJSONObject(i);int a=c.getInt("start"),b=c.getInt("end");if(a>=end)break;if(b<=start)continue;byte[] bytes=new byte[c.getInt("bytes")];original.seek(c.getLong("byteStart"));original.readFully(bytes);rangeBytesRead+=bytes.length;String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();if(text.length()!=b-a||!Utf8Text.hash(text).equals(c.getString("hash")))throw new IOException("范围原文块校验失败");value.append(text,Math.max(0,start-a),Math.min(text.length(),end-a));}
                String text=value.toString();if(text.length()!=end-start)throw new IOException("原文范围缺失");pieces.put(new JSONObject().put("start",start).put("end",end).put("text",text).put("hash",Utf8Text.hash(text)));
            }
        }
        rangeReads++;
        return new JSONObject().put("version",version).put("length",length).put("pieces",pieces);
    }
    private File memoryBodyFile(String key,String hash)throws IOException{
        if(!hash.matches("[0-9a-f]{64}")||!key.equals("memory-body-"+hash))throw new IOException("阅读档案正文引用无效");
        return new File(memoryBodies,hash+".utf8");
    }
    private String readMemoryBody(JSONObject ref)throws Exception{
        String key=ref.getString("key"),hash=ref.getString("hash");File target=memoryBodyFile(key,hash);
        long chars=ref.getLong("chars");if(chars<0||chars>30000000)throw new IOException("阅读档案正文长度无效");
        String text;
        try(Reader reader=new InputStreamReader(new AtomicFile(target).openRead(),StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT))){
            StringBuilder value=new StringBuilder();char[] buffer=new char[8192];int count;
            while((count=reader.read(buffer))!=-1){value.append(buffer,0,count);if(value.length()>chars)throw new IOException("阅读档案正文长度校验失败");}
            text=value.toString();
        }
        if(text.length()!=chars||!Utf8Text.hash(text).equals(hash))throw new IOException("阅读档案正文缺失或校验失败");
        return text;
    }
    synchronized void putMemoryBody(JSONObject body)throws Exception{
        String key=body.getString("key"),hash=body.getString("hash"),text=body.getString("text");File target=memoryBodyFile(key,hash);
        if(text.length()>30000000||!Utf8Text.hash(text).equals(hash))throw new IOException("阅读档案正文校验失败");
        if(target.exists()||new File(target.getPath()+".bak").exists()){
            JSONObject ref=new JSONObject().put("key",key).put("hash",hash).put("chars",text.length());
            if(!readMemoryBody(ref).equals(text))throw new IOException("阅读档案正文对象冲突");return;
        }
        AtomicFile file=new AtomicFile(target);FileOutputStream stream=null;
        try{stream=file.startWrite();Utf8Text.write(stream,text);file.finishWrite(stream);}catch(Exception e){if(stream!=null)file.failWrite(stream);throw e;}
    }
    synchronized JSONArray readMemoryBodies(JSONArray refs)throws Exception{
        if(refs.length()>256)throw new IOException("请分批读取阅读档案正文");
        JSONArray result=new JSONArray();
        for(int i=0;i<refs.length();i++){
            JSONObject ref=refs.getJSONObject(i);String text=readMemoryBody(ref);
            result.put(new JSONObject().put("key",ref.getString("key")).put("hash",ref.getString("hash")).put("text",text));
        }
        return result;
    }
    synchronized Object readMemoryIndex()throws Exception{
        File path=new File(root,"memory-index.json");
        if(!path.exists()&&!new File(path.getPath()+".bak").exists())return JSONObject.NULL;
        if(path.length()>16000000)throw new IOException("阅读档案索引超过当前支持体积");
        byte[] bytes=new AtomicFile(path).readFully();if(bytes.length>16000000)throw new IOException("阅读档案索引超过当前支持体积");
        return new JSONTokener(new String(bytes,StandardCharsets.UTF_8)).nextValue();
    }
    synchronized void writeMemoryIndex(Object index)throws Exception{
        if(!(index instanceof JSONObject))throw new IOException("阅读档案索引格式无效");
        byte[] bytes=index.toString().getBytes(StandardCharsets.UTF_8);if(bytes.length>16000000)throw new IOException("阅读档案索引超过当前支持体积");
        write(new File(root,"memory-index.json"),bytes);
    }
    synchronized void save(JSONObject state)throws Exception{
        if(state.optInt("schema")!=1)throw new IOException("资料格式无效");
        state.remove("secrets");state.remove("exportedAt");
        JSONArray books=state.getJSONArray("books");
        for(int i=0;i<books.length();i++){
            JSONObject book=books.getJSONObject(i);
            String version=book.getString("version");
            if(!book.optString("text").isEmpty()||!textFile(version).exists())throw new IOException("原文尚未保存或未分开存储");
            if(!lengths.containsKey(version))scanText(version,false);
            int length=lengths.get(version);
            if(book.has("textLength")&&book.getLong("textLength")!=length)throw new IOException("原文长度与记录不一致");
            book.put("textLength",length);
            ensureTextIndex(version,null);
        }
        JSONArray memories=state.getJSONArray("memories");
        for(int i=0;i<memories.length();i++){
            JSONObject memory=memories.getJSONObject(i);
            if(memory.has("text"))throw new IOException("阅读档案正文尚未分开存储");
            JSONObject ref=memory.getJSONObject("bodyRef");File body=memoryBodyFile(ref.getString("key"),ref.getString("hash"));
            long chars=ref.getLong("chars");if(chars<0||chars>30000000||(!body.exists()&&!new File(body.getPath()+".bak").exists()))throw new IOException("阅读档案正文尚未保存");
        }
        // Full import and one-time legacy migration only. Normal writes are typed.
        replaceMetadata(state);metadataWrites++;
        if(!new File(root,"initialized").exists())write(new File(root,"initialized"),new byte[]{1});
    }
    synchronized JSONObject load()throws Exception{
        JSONObject current=loadMetadata();if(current!=null){if(!exists(new File(root,"records-authority")))write(new File(root,"records-authority"),new byte[]{1});return current;}
        if(exists(new File(root,"records-authority")))throw new IOException("资料库当前记录缺失，未回退历史state.json");
        File path=new File(root,"state.json");
        if(!path.exists()&&!new File(root,"state.json.bak").exists()){
            if(new File(root,"initialized").exists())throw new IOException("原生资料缺失，请使用自己的备份恢复，未自动回退旧资料");
            return null;
        }
        JSONObject state=new JSONObject(new String(new AtomicFile(path).readFully(),StandardCharsets.UTF_8));
        if(state.optInt("schema")!=1)throw new IOException("资料格式无效");
        state.remove("secrets");state.remove("exportedAt");
        JSONArray books=state.getJSONArray("books");
        boolean migrated=false;
        for(int i=0;i<books.length();i++){
            JSONObject book=books.getJSONObject(i);String version=book.getString("version");File text=textFile(version);
            if(!text.exists()&&!new File(text.getPath()+".bak").exists())throw new IOException("保存的原文缺失");
            if(!book.has("textLength")){scanText(version,false);book.put("textLength",lengths.get(version));migrated=true;}
            else{long length=book.getLong("textLength");if(length<=0||length>30000000)throw new IOException("原文长度记录无效");lengths.put(version,(int)length);}
            book.put("text","");
        }
        // The JS adapter's unique codec externalizes both Memory and private task
        // material before this first database publication. Never publish a Java
        // interpretation of a legacy snapshot, even if Memory already has refs.
        state.put("nativeStorageMigrationRequired",true);
        return state;
    }
    private File taskFile(String key,String hash)throws IOException{if(!hash.matches("[0-9a-f]{64}")||!key.equals("task-material-"+hash))throw new IOException("任务材料引用无效");return new File(taskMaterials,hash+".json");}
    synchronized void putTaskMaterial(JSONObject value)throws Exception{
        String text=value.getString("text"),hash=value.getString("hash");File path=taskFile(value.getString("key"),hash);byte[] bytes=text.getBytes(StandardCharsets.UTF_8);
        if(bytes.length!=value.getLong("bytes")||!Utf8Text.hash(text).equals(hash))throw new IOException("任务材料校验失败");
        if(path.exists()||new File(path.getPath()+".bak").exists()){if(!Arrays.equals(new AtomicFile(path).readFully(),bytes))throw new IOException("任务材料对象冲突");return;}write(path,bytes);
    }
    synchronized JSONArray readTaskMaterials(JSONArray refs)throws Exception{
        JSONArray out=new JSONArray();for(int i=0;i<refs.length();i++){JSONObject ref=refs.getJSONObject(i);File path=taskFile(ref.getString("key"),ref.getString("hash"));byte[] bytes=new AtomicFile(path).readFully();String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();if(bytes.length!=ref.getLong("bytes")||!Utf8Text.hash(text).equals(ref.getString("hash")))throw new IOException("任务材料缺失或校验失败");out.put(new JSONObject().put("key",ref.getString("key")).put("hash",ref.getString("hash")).put("text",text));}return out;
    }
    private String recordKey(String name,JSONObject value)throws Exception{
        if(name.equals("companionWorkspaces"))return new JSONArray().put(value.getString("bookId")).put(value.getString("version")).put(value.getString("partnerId")).put(value.getString("source")).toString();
        String id=value.getString("id");if(id.isEmpty())throw new IOException("实体存储身份缺失");return id;
    }
    private JSONObject head()throws Exception{try(Cursor cursor=database.rawQuery("SELECT json FROM head WHERE k='current'",null)){return cursor.moveToFirst()?new JSONObject(cursor.getString(0)):null;}}
    private JSONObject loadMetadata()throws Exception{
        JSONObject state=head();if(state==null){try(Cursor cursor=database.rawQuery("SELECT 1 FROM head WHERE k='authority'",null)){if(cursor.moveToFirst())throw new IOException("资料库已初始化但当前头缺失，未回退旧档");}return null;}state.remove("storageOrder");for(String name:COLLECTIONS)state.put(name,new JSONArray());
        try(Cursor cursor=database.rawQuery("SELECT collection,json FROM entities ORDER BY ordinal",null)){while(cursor.moveToNext()){String name=cursor.getString(0);if(!COLLECTION_SET.contains(name))throw new IOException("未知资料集合");state.getJSONArray(name).put(new JSONObject(cursor.getString(1)));}}
        return state;
    }
    private void checkRef(JSONObject owner)throws Exception{
        JSONObject ref=owner.optJSONObject("materialRef");if(ref!=null&&!exists(taskFile(ref.getString("key"),ref.getString("hash"))))throw new IOException("任务材料尚未保存");
        JSONObject pending=owner.optJSONObject("pendingReceipt");if(pending!=null)checkRef(pending);
    }
    private void checkRecord(String name,JSONObject value)throws Exception{
        if(name.equals("books")){String version=value.getString("version");if(!value.optString("text").isEmpty()||!exists(textFile(version)))throw new IOException("原文未分开存储");JSONObject index=new JSONObject(new String(new AtomicFile(indexFile(version)).readFully(),StandardCharsets.UTF_8));if(!index.getString("version").equals(version)||value.getLong("textLength")!=index.getLong("length"))throw new IOException("原文范围身份未保存");}
        if(name.equals("memories")){if(value.has("text"))throw new IOException("正文未分开存储");JSONObject ref=value.getJSONObject("bodyRef");if(!exists(memoryBodyFile(ref.getString("key"),ref.getString("hash"))))throw new IOException("正文未保存");}
        checkRef(value);
    }
    private long putRecords(String name,JSONArray values,long order)throws Exception{
        for(int i=0;i<values.length();i++){JSONObject value=values.getJSONObject(i);checkRecord(name,value);String key=recordKey(name,value);Long prior=null;try(Cursor cursor=database.rawQuery("SELECT ordinal FROM entities WHERE collection=? AND k=?",new String[]{name,key})){if(cursor.moveToFirst())prior=cursor.getLong(0);}long position=prior==null?order++:prior;database.execSQL("INSERT OR REPLACE INTO entities(collection,k,json,ordinal) VALUES(?,?,?,?)",new Object[]{name,key,value.toString(),position});}return order;
    }
    private void replaceMetadata(JSONObject state)throws Exception{
        JSONObject scalar=new JSONObject(state.toString());for(String name:COLLECTIONS)scalar.remove(name);scalar.remove("secrets");scalar.remove("exportedAt");
        database.beginTransaction();try{database.execSQL("DELETE FROM entities");long order=0;for(String name:COLLECTIONS){JSONArray values=state.optJSONArray(name);if(values!=null)order=putRecords(name,values,order);}scalar.put("storageOrder",order);database.execSQL("INSERT OR REPLACE INTO head(k,json) VALUES('current',?)",new Object[]{scalar.toString()});database.execSQL("INSERT OR REPLACE INTO head(k,json) VALUES('authority','true')");database.setTransactionSuccessful();}finally{database.endTransaction();}
        write(new File(root,"records-authority"),new byte[]{1});
    }
    synchronized void applyStateChanges(JSONObject changes)throws Exception{
        JSONArray names=changes.names();if(names!=null)for(int i=0;i<names.length();i++)if(!Arrays.asList("id","collections","set","unset").contains(names.getString(i)))throw new IOException("局部提交字段无效");
        JSONObject collections=changes.getJSONObject("collections");Iterator<String> keys=collections.keys();while(keys.hasNext())if(!COLLECTION_SET.contains(keys.next()))throw new IOException("局部提交集合无效");
        database.beginTransaction();try{JSONObject scalar=head();if(scalar==null)throw new IOException("局部资料尚未初始化");long order=scalar.optLong("storageOrder");
            JSONObject set=changes.optJSONObject("set");if(set!=null){Iterator<String> fields=set.keys();while(fields.hasNext()){String key=fields.next();if(!Arrays.asList("partnerId","settings","resume").contains(key))throw new IOException("局部提交标量无效");scalar.put(key,set.get(key));}}
            JSONArray unset=changes.optJSONArray("unset");if(unset!=null)for(int i=0;i<unset.length();i++){if(!unset.getString(i).equals("resume"))throw new IOException("局部删除标量无效");scalar.remove("resume");}
            for(String name:COLLECTIONS){JSONObject change=collections.optJSONObject(name);if(change==null)continue;JSONArray removed=change.optJSONArray("remove");if(removed!=null)for(int i=0;i<removed.length();i++)database.execSQL("DELETE FROM entities WHERE collection=? AND k=?",new Object[]{name,removed.getString(i)});JSONArray put=change.optJSONArray("put");if(put!=null)order=putRecords(name,put,order);}
            scalar.put("storageOrder",order);database.execSQL("UPDATE head SET json=? WHERE k='current'",new Object[]{scalar.toString()});database.setTransactionSuccessful();
        }finally{database.endTransaction();}metadataWrites++;
    }
    synchronized JSONObject statistics()throws JSONException{JSONObject result=new JSONObject();result.put("textWrites",textWrites);result.put("metadataWrites",metadataWrites);result.put("rangeReads",rangeReads);result.put("rangeBytesRead",rangeBytesRead);return result;}
}
