package com.yixu.reading;

import java.util.function.Predicate;

/** Packaged source rules. A matching package alone never grants a reading surface. */
final class ReadingSource {
    static final ReadingSource QIDIAN=new ReadingSource("qidian","起点读书","com.qidian.QDReader",true,"7.9.480",
        new String[]{"qd_reader_layoutRoot","rlBookReadRoot"},new String[]{},"commentVP");
    static final ReadingSource LEGADO=new ReadingSource("legado-team","阅读（LegadoTeam）","com.legado.app.release",false,"",
        new String[]{"read_view"},new String[]{"read_menu","search_menu"},null);
    static final ReadingSource[] ALL={QIDIAN,LEGADO};
    final String id,name,packageName,testedVersion,commentId;
    final boolean tested;
    final String[] readingIds,blockedIds;
    private ReadingSource(String id,String name,String packageName,boolean tested,String testedVersion,String[] readingIds,String[] blockedIds,String commentId){
        this.id=id;this.name=name;this.packageName=packageName;this.tested=tested;this.testedVersion=testedVersion;this.readingIds=readingIds;this.blockedIds=blockedIds;this.commentId=commentId;
    }
    static ReadingSource find(String id){for(ReadingSource source:ALL)if(source.id.equals(id))return source;return null;}
    int classify(String foregroundPackage,boolean seenReader,Predicate<String> visible){
        if(!packageName.equals(foregroundPackage))return 0;
        for(String item:blockedIds)if(visible.test(item))return 0;
        if(commentId!=null&&visible.test(commentId))return seenReader?2:0;
        for(String item:readingIds)if(visible.test(item))return 1;
        return 0;
    }
}
