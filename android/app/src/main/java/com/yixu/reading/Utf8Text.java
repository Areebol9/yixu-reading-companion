package com.yixu.reading;

import java.io.*;
import java.nio.charset.*;
import java.security.*;
import java.util.Locale;

/** UTF-8 matches TextEncoder, including replacement of isolated UTF-16 surrogates. */
final class Utf8Text {
    static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    static void write(OutputStream target,String text)throws IOException{
        CharsetEncoder encoder=StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE).replaceWith(new byte[]{(byte)0xef,(byte)0xbf,(byte)0xbd});
        // Finalize the encoder (including a trailing unmatched surrogate), while
        // keeping AtomicFile's stream open for its own sync/commit operation.
        OutputStream unclosed=new FilterOutputStream(target){
            @Override public void write(byte[] bytes,int offset,int length)throws IOException{out.write(bytes,offset,length);}
            @Override public void close()throws IOException{flush();}
        };
        Writer writer=new OutputStreamWriter(unclosed,encoder);writer.write(text);writer.close();
    }
    static String hash(String text)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        OutputStream discard=new OutputStream(){@Override public void write(int b){}@Override public void write(byte[] b,int off,int len){}};
        write(new DigestOutputStream(discard,digest),text);return hex(digest.digest());
    }
    static String hash(InputStream input)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] block=new byte[16384];int n;
        while((n=input.read(block))!=-1)digest.update(block,0,n);return hex(digest.digest());
    }
}
